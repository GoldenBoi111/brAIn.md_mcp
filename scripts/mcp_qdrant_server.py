#!/usr/bin/env python3
"""MCP server for local vault create/read flows backed by Qdrant.

Qdrant stores vector embeddings plus stable file identity metadata only:
- tenant_id
- file_id
- chunk_index
- embedding_model

File contents stay on the local filesystem. A small local catalog maps each
stable file ID to its current path so folder/file moves only update the path
mapping instead of rewriting vector rows.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
import uuid
import time

from vault_auth import TokenClaims, TokenError, require_scope, verify_token
from vault_manager import (
    DEFAULT_ROOT,
    VaultContext,
    VaultError,
    append_file,
    delete_path,
    create_folder,
    create_vault,
    get_item_metadata,
    get_vault_context,
    list_folder_contents,
    normalize_rel_path,
    path_exists,
    move_path,
    read_file,
    write_file,
)
from vault_catalog import (
    create_file_record,
    ensure_file_id,
    get_file_id_for_path,
    get_path_for_file_id,
    list_file_ids_under_path,
    list_paths_under_path,
)


LOG = logging.getLogger("mcp_qdrant_server")
MCP_PROTOCOL_VERSION = "2024-11-05"


def chunk_markdown(content: str, max_chars: int = 1800) -> list[str]:
    lines = content.splitlines()
    chunks: list[str] = []
    current: list[str] = []

    def flush() -> None:
        if not current:
            return
        chunk = "\n".join(current).strip()
        if chunk:
            chunks.append(chunk)
        current.clear()

    for line in lines:
        if line.lstrip().startswith("#") and current:
            flush()
        current.append(line)
        if sum(len(part) + 1 for part in current) >= max_chars:
            flush()

    flush()
    if chunks:
        return chunks

    text = content.strip()
    if not text:
        return [""]
    return [text[i : i + max_chars] for i in range(0, len(text), max_chars)]


def absolute_file_location(vault_root: Path, relative_path: str) -> str:
    return str((vault_root / relative_path).resolve())


def _path_within_scope(path: str, roots: tuple[str, ...]) -> bool:
    if not roots:
        return True

    candidate = normalize_rel_path(path).as_posix()
    for root in roots:
        allowed_rel = normalize_rel_path(root).as_posix()
        if allowed_rel == ".":
            return True
        if candidate == allowed_rel or candidate.startswith(f"{allowed_rel}/"):
            return True
    return False


def assert_read_allowed(path: str, read_roots: tuple[str, ...], *, action: str) -> None:
    if not _path_within_scope(path, read_roots):
        raise VaultError(f"{action} is restricted outside the token's read roots: {path}")


def assert_write_allowed(path: str, write_roots: tuple[str, ...], *, action: str) -> None:
    if not _path_within_scope(path, write_roots):
        raise VaultError(f"{action} is restricted outside the token's write roots: {path}")


def _filter_matches_by_scope(
    matches: list[dict[str, Any]],
    *,
    ctx: VaultContext,
    read_roots: tuple[str, ...],
) -> list[dict[str, Any]]:
    if not read_roots:
        return matches

    filtered: list[dict[str, Any]] = []
    for match in matches:
        match_file_id = str(match.get("file_id") or "")
        match_path = None
        if match_file_id:
            match_path = get_path_for_file_id(ctx.vault_root, match_file_id)
        if not match_path:
            legacy_path = str(match.get("legacy_file_path") or "")
            match_path = legacy_path or None
        if match_path and _path_within_scope(match_path, read_roots):
            filtered.append(match)
    return filtered


class EmbeddingClient:
    def __init__(self) -> None:
        self.base_url = os.getenv("JASPER_EMBEDDER_URL", "http://localhost:8001").rstrip("/")
        self.timeout = float(os.getenv("JASPER_EMBEDDER_TIMEOUT_SECONDS", "60"))
        self.dimension = int(os.getenv("QDRANT_VECTOR_SIZE", "2048"))

    def _request_json(self, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST" if payload is not None else "GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            raise VaultError(f"Jasper embedder request failed ({exc.code}): {raw}") from exc

    def metadata(self) -> dict[str, Any]:
        return self._request_json("/metadata")

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        data = self._request_json("/embed", {"texts": texts})
        vectors = data.get("vectors")
        if not isinstance(vectors, list):
            raise VaultError("Embedder returned an invalid vectors payload")
        return [[float(value) for value in vector] for vector in vectors]

    def embed_text(self, text: str) -> list[float]:
        return self.embed_texts([text])[0]


class QdrantVectorStore:
    def __init__(self, embedder: EmbeddingClient) -> None:
        self.base_url = os.getenv("QDRANT_URL", "http://localhost:6333").rstrip("/")
        self.api_key = os.getenv("QDRANT_API_KEY", "")
        self.collection = os.getenv("QDRANT_COLLECTION", "vault_chunks")
        self.timeout = float(os.getenv("QDRANT_TIMEOUT_SECONDS", "30"))
        self.vector_size = int(os.getenv("QDRANT_VECTOR_SIZE", str(embedder.dimension)))
        self.embedder = embedder
        self.ensure_collection()

    def _request_json(self, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["api-key"] = self.api_key
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            raise VaultError(f"Qdrant request failed ({exc.code}): {raw}") from exc

    def _stable_point_id(self, tenant_id: str, file_id: str, chunk_hash: str, occurrence: int) -> str:
        namespace = uuid.uuid5(uuid.NAMESPACE_URL, f"{tenant_id}:{file_id}")
        return str(uuid.uuid5(namespace, f"{chunk_hash}:{occurrence}"))

    def ensure_collection(self) -> None:
        payload = {
            "vectors": {
                "size": self.vector_size,
                "distance": "Cosine",
            }
        }
        try:
            self._request_json("PUT", f"/collections/{self.collection}", payload)
        except VaultError as exc:
            if "already exists" in str(exc).lower():
                return
            raise

    def scroll_file_points(
        self,
        *,
        tenant_id: str,
        file_id: str,
        legacy_file_path: str | None = None,
    ) -> list[dict[str, Any]]:
        points: list[dict[str, Any]] = []
        offset: Any | None = None
        while True:
            payload: dict[str, Any] = {
                "limit": 100,
                "with_payload": True,
                "with_vector": False,
                "filter": {
                    "must": [
                        {"key": "tenant_id", "match": {"value": tenant_id}},
                    ],
                },
            }
            if legacy_file_path:
                payload["filter"]["should"] = [
                    {"key": "file_id", "match": {"value": file_id}},
                    {"key": "file_path", "match": {"value": legacy_file_path}},
                ]
                payload["filter"]["min_should"] = 1
            else:
                payload["filter"]["must"].append({"key": "file_id", "match": {"value": file_id}})
            if offset is not None:
                payload["offset"] = offset
            data = self._request_json("POST", f"/collections/{self.collection}/points/scroll", payload)
            result = data.get("result", {}) or {}
            batch = result.get("points", [])
            if isinstance(batch, list):
                points.extend(batch)
            offset = result.get("next_page_offset")
            if not offset or not batch:
                break
        return points

    def update_file(
        self,
        *,
        tenant_id: str,
        file_id: str,
        content: str,
        embedding_model: str,
        legacy_file_path: str | None = None,
    ) -> dict[str, int]:
        existing_points = self.scroll_file_points(
            tenant_id=tenant_id,
            file_id=file_id,
            legacy_file_path=legacy_file_path,
        )
        existing_by_key: dict[tuple[str, int], dict[str, Any]] = {}
        existing_ids: set[str] = set()
        hash_counts: dict[str, int] = {}

        for point in sorted(
            existing_points,
            key=lambda item: int((item.get("payload") or {}).get("chunk_index", 0)),
        ):
            payload = point.get("payload", {}) or {}
            chunk_hash = str(payload.get("chunk_hash", ""))
            occurrence = hash_counts.get(chunk_hash, 0)
            hash_counts[chunk_hash] = occurrence + 1
            key = (chunk_hash, occurrence)
            existing_by_key[key] = point
            if point.get("id") is not None:
                existing_ids.add(str(point["id"]))

        chunks = chunk_markdown(content)
        vectors = self.embedder.embed_texts(chunks)
        new_points: list[dict[str, Any]] = []
        new_ids: set[str] = set()
        new_hash_counts: dict[str, int] = {}

        for index, (chunk_text, vector) in enumerate(zip(chunks, vectors, strict=False)):
            chunk_hash = hashlib.sha256(chunk_text.encode("utf-8")).hexdigest()
            occurrence = new_hash_counts.get(chunk_hash, 0)
            new_hash_counts[chunk_hash] = occurrence + 1
            key = (chunk_hash, occurrence)
            existing_point = existing_by_key.get(key)
            if existing_point and existing_point.get("id") is not None:
                point_id = str(existing_point["id"])
            else:
                point_id = self._stable_point_id(tenant_id, file_id, chunk_hash, occurrence)

            new_ids.add(point_id)
            new_points.append(
                {
                    "id": point_id,
                    "vector": vector,
                    "payload": {
                        "tenant_id": tenant_id,
                        "file_id": file_id,
                        "chunk_index": index,
                        "embedding_model": embedding_model,
                        "chunk_hash": chunk_hash,
                    },
                }
            )

        points_to_delete = sorted(existing_ids - new_ids)
        if points_to_delete:
            self._request_json(
                "POST",
                f"/collections/{self.collection}/points/delete",
                {"points": points_to_delete, "wait": True},
            )

        if new_points:
            self._request_json(
                "PUT",
                f"/collections/{self.collection}/points",
                {"points": new_points, "wait": True},
            )

        return {
            "created_or_updated_chunks": len(new_points),
            "deleted_chunks": len(points_to_delete),
            "existing_chunks": len(existing_points),
        }

    def delete_file(self, *, tenant_id: str, file_id: str) -> None:
        payload = {
            "filter": {
                "must": [
                    {"key": "tenant_id", "match": {"value": tenant_id}},
                    {"key": "file_id", "match": {"value": file_id}},
                ]
            },
            "wait": True,
        }
        self._request_json("POST", f"/collections/{self.collection}/points/delete", payload)

    def delete_files(self, *, tenant_id: str, file_ids: list[str]) -> int:
        deleted = 0
        for file_id in file_ids:
            self.delete_file(tenant_id=tenant_id, file_id=file_id)
            deleted += 1
        return deleted

    def delete_paths(self, *, tenant_id: str, paths: list[str]) -> int:
        deleted = 0
        for path in paths:
            payload = {
                "filter": {
                    "must": [
                        {"key": "tenant_id", "match": {"value": tenant_id}},
                        {"key": "file_path", "match": {"value": path}},
                    ]
                },
                "wait": True,
            }
            self._request_json("POST", f"/collections/{self.collection}/points/delete", payload)
            deleted += 1
        return deleted

    def search(self, *, tenant_id: str, query_vector: list[float], top_k: int) -> list[dict[str, Any]]:
        payload = {
            "vector": query_vector,
            "limit": top_k,
            "with_payload": True,
            "filter": {
                "must": [
                    {"key": "tenant_id", "match": {"value": tenant_id}},
                ]
            },
        }
        data = self._request_json("POST", f"/collections/{self.collection}/points/search", payload)
        results = data.get("result", [])
        if not isinstance(results, list):
            return []
        matches: list[dict[str, Any]] = []
        for item in results:
            payload = item.get("payload", {}) or {}
            matches.append(
                {
                    "id": item.get("id"),
                    "score": float(item.get("score", 0.0)),
                    "file_id": payload.get("file_id"),
                    "legacy_file_path": payload.get("file_path"),
                    "chunk_index": payload.get("chunk_index"),
                    "embedding_model": payload.get("embedding_model"),
                }
            )
        return matches


def create_item(
    ctx: VaultContext,
    *,
    vector_store: QdrantVectorStore,
    embedding_model: str,
    kind: str,
    path: str,
    content: str = "",
    write_roots: tuple[str, ...] = (),
) -> dict[str, Any]:
    relative = normalize_rel_path(path).as_posix()
    assert_write_allowed(relative, write_roots, action="create")
    if kind == "folder":
        created = create_folder(ctx, path)
        return {
            "kind": "folder",
            "relative_path": relative,
            "file_location": str(created.resolve()),
        }

    existing_path = ctx.rel(path)
    if existing_path.exists():
        raise VaultError(f"File already exists: {path}")

    file_id = create_file_record(ctx.vault_root, relative)
    created = write_file(ctx, path, content)
    update_result = vector_store.update_file(
        tenant_id=ctx.vault_root.name,
        file_id=file_id,
        content=content,
        embedding_model=embedding_model,
    )
    return {
        "kind": "file",
        "relative_path": relative,
        "file_id": file_id,
        "file_location": str(created.resolve()),
        "index_result": update_result,
    }


def read_item(
    ctx: VaultContext,
    *,
    vector_store: QdrantVectorStore,
    request_text: str,
    top_k: int = 3,
    read_roots: tuple[str, ...] = (),
) -> dict[str, Any]:
    query_vector = vector_store.embedder.embed_text(request_text)
    matches = vector_store.search(
        tenant_id=ctx.vault_root.name,
        query_vector=query_vector,
        top_k=max(top_k * 5, top_k),
    )
    matches = _filter_matches_by_scope(matches, ctx=ctx, read_roots=read_roots)
    if not matches:
        return {"matches": [], "file_location": None, "relative_path": None, "file_id": None, "content": None}

    best = matches[0]
    best_file_id = str(best.get("file_id") or "")
    best_path = None
    if best_file_id:
        best_path = get_path_for_file_id(ctx.vault_root, best_file_id)
    if not best_path:
        best_path = str(best.get("legacy_file_path") or "")
    if not best_path:
        raise VaultError("Qdrant returned a match without a resolvable file path")
    content = read_file(ctx, best_path)
    enriched_matches: list[dict[str, Any]] = []
    for match in matches:
        match_file_id = str(match.get("file_id") or "")
        match_path = None
        if match_file_id:
            match_path = get_path_for_file_id(ctx.vault_root, match_file_id)
        if not match_path:
            legacy_path = str(match.get("legacy_file_path") or "")
            match_path = legacy_path or None
        enriched_matches.append(
            {
                "file_id": match_file_id or None,
                "relative_path": match_path,
                "file_location": absolute_file_location(ctx.vault_root, match_path) if match_path else None,
                "score": round(float(match["score"]), 4),
                "chunk_index": match.get("chunk_index"),
            }
        )

    return {
        "matches": enriched_matches,
        "file_id": best_file_id or None,
        "file_location": absolute_file_location(ctx.vault_root, best_path),
        "relative_path": best_path,
        "content": content,
        "score": round(float(best["score"]), 4),
    }


def update_item(
    ctx: VaultContext,
    *,
    vector_store: QdrantVectorStore,
    embedding_model: str,
    path: str,
    content: str,
    write_roots: tuple[str, ...] = (),
) -> dict[str, Any]:
    relative = normalize_rel_path(path).as_posix()
    assert_write_allowed(relative, write_roots, action="update")
    existing_path = ctx.rel(path)
    if not existing_path.exists():
        raise VaultError(f"File does not exist: {path}")
    if existing_path.is_dir():
        raise VaultError(f"Path is a folder, not a file: {path}")

    updated = write_file(ctx, path, content)
    file_id = get_file_id_for_path(ctx.vault_root, relative) or ensure_file_id(ctx.vault_root, relative)
    index_result = vector_store.update_file(
        tenant_id=ctx.vault_root.name,
        file_id=file_id,
        content=content,
        embedding_model=embedding_model,
        legacy_file_path=relative,
    )
    return {
        "kind": "file",
        "relative_path": relative,
        "file_id": file_id,
        "file_location": str(updated.resolve()),
        "index_result": index_result,
    }


def append_item(
    ctx: VaultContext,
    *,
    vector_store: QdrantVectorStore,
    embedding_model: str,
    path: str,
    content: str,
    write_roots: tuple[str, ...] = (),
) -> dict[str, Any]:
    relative = normalize_rel_path(path).as_posix()
    assert_write_allowed(relative, write_roots, action="append")
    existing_path = ctx.rel(path)
    if existing_path.exists() and existing_path.is_dir():
        raise VaultError(f"Path is a folder, not a file: {path}")

    updated = append_file(ctx, path, content)
    file_id = get_file_id_for_path(ctx.vault_root, relative) or ensure_file_id(ctx.vault_root, relative)
    current_content = read_file(ctx, path)
    index_result = vector_store.update_file(
        tenant_id=ctx.vault_root.name,
        file_id=file_id,
        content=current_content,
        embedding_model=embedding_model,
        legacy_file_path=relative,
    )
    return {
        "kind": "file",
        "relative_path": relative,
        "file_id": file_id,
        "file_location": str(updated.resolve()),
        "index_result": index_result,
    }


def search_item(
    ctx: VaultContext,
    *,
    vector_store: QdrantVectorStore,
    request_text: str,
    top_k: int = 3,
    read_roots: tuple[str, ...] = (),
) -> dict[str, Any]:
    query_vector = vector_store.embedder.embed_text(request_text)
    matches = vector_store.search(
        tenant_id=ctx.vault_root.name,
        query_vector=query_vector,
        top_k=max(top_k * 5, top_k),
    )
    matches = _filter_matches_by_scope(matches, ctx=ctx, read_roots=read_roots)
    enriched_matches: list[dict[str, Any]] = []
    for match in matches:
        match_file_id = str(match.get("file_id") or "")
        match_path = None
        if match_file_id:
            match_path = get_path_for_file_id(ctx.vault_root, match_file_id)
        if not match_path:
            legacy_path = str(match.get("legacy_file_path") or "")
            match_path = legacy_path or None
        enriched_matches.append(
            {
                "file_id": match_file_id or None,
                "relative_path": match_path,
                "file_location": absolute_file_location(ctx.vault_root, match_path) if match_path else None,
                "score": round(float(match["score"]), 4),
                "chunk_index": match.get("chunk_index"),
                "embedding_model": match.get("embedding_model"),
            }
        )

    return {"matches": enriched_matches}


def move_item(
    ctx: VaultContext,
    *,
    source: str,
    destination: str,
    write_roots: tuple[str, ...] = (),
) -> dict[str, Any]:
    source_relative = normalize_rel_path(source).as_posix()
    destination_relative = normalize_rel_path(destination).as_posix()
    assert_write_allowed(source_relative, write_roots, action="move source")
    assert_write_allowed(destination_relative, write_roots, action="move destination")
    src, dst = move_path(ctx, source, destination)
    moved_file_ids = list_file_ids_under_path(ctx.vault_root, destination_relative)
    moved_files: list[dict[str, Any]] = []
    for file_id in moved_file_ids:
        current_path = get_path_for_file_id(ctx.vault_root, file_id)
        if not current_path:
            continue
        moved_files.append(
            {
                "file_id": file_id,
                "relative_path": current_path,
                "file_location": str((ctx.vault_root / current_path).resolve()),
            }
        )

    return {
        "source_relative_path": source_relative,
        "destination_relative_path": destination_relative,
        "source_location": str(src),
        "destination_location": str(dst),
        "moved_files": moved_files,
        "moved_count": len(moved_files),
    }


def delete_item(
    ctx: VaultContext,
    *,
    vector_store: QdrantVectorStore,
    path: str,
    write_roots: tuple[str, ...] = (),
) -> dict[str, Any]:
    relative = normalize_rel_path(path).as_posix()
    assert_write_allowed(relative, write_roots, action="delete")
    existing_path = ctx.rel(path)
    if not existing_path.exists():
        raise VaultError(f"Path does not exist: {path}")

    file_ids = list_file_ids_under_path(ctx.vault_root, relative)
    legacy_paths = list_paths_under_path(ctx.vault_root, relative)
    deleted_target = delete_path(ctx, path)
    deleted_vectors = vector_store.delete_files(tenant_id=ctx.vault_root.name, file_ids=file_ids)
    deleted_vectors += vector_store.delete_paths(tenant_id=ctx.vault_root.name, paths=legacy_paths)
    return {
        "relative_path": relative,
        "file_location": str(deleted_target),
        "deleted_file_ids": file_ids,
        "deleted_legacy_paths": legacy_paths,
        "deleted_vector_groups": deleted_vectors,
    }


class JsonRpcError(Exception):
    def __init__(self, code: int, message: str, data: Any | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


class MCPServer:
    def __init__(self, base_root: Path) -> None:
        self.base_root = base_root.resolve()
        self.embedder = EmbeddingClient()
        self.vector_store = QdrantVectorStore(self.embedder)
        meta = self.embedder.metadata()
        self.embedding_model_name = str(meta.get("model_name", "infgrad/Jasper-Token-Compression-600M"))
        revocation_env = os.getenv("MCP_JWT_REVOCATION_PATH")
        self.revocation_path = Path(revocation_env) if revocation_env else None
        usage_env = os.getenv("MCP_USAGE_LOG_PATH")
        self.usage_log_path = Path(usage_env) if usage_env else Path.cwd() / "vaults" / ".mcp-jwt-usage.jsonl"

    def tools(self) -> list[dict[str, Any]]:
        return [
            {
                "name": "create_item",
                "description": "Create a file or folder inside an authorized tenant vault and index stable file IDs in Qdrant.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "access_token": {"type": "string"},
                        "kind": {"type": "string", "enum": ["file", "folder"]},
                        "path": {"type": "string"},
                        "content": {"type": "string"},
                    },
                    "required": ["access_token", "kind", "path"],
                },
            },
            {
                "name": "read_item",
                "description": "Embed a natural-language request and return the best matching file ID, location, and content.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "access_token": {"type": "string"},
                        "request_text": {"type": "string"},
                        "top_k": {"type": "integer", "minimum": 1, "maximum": 10},
                    },
                    "required": ["access_token", "request_text"],
                },
            },
            {
                "name": "search_item",
                "description": "Embed a natural-language request and return matching file IDs and locations without reading file contents.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "access_token": {"type": "string"},
                        "request_text": {"type": "string"},
                        "top_k": {"type": "integer", "minimum": 1, "maximum": 10},
                    },
                    "required": ["access_token", "request_text"],
                },
            },
            {
                "name": "update_item",
                "description": "Update an existing file in the vault and smartly refresh only the changed Qdrant chunks by file ID.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "access_token": {"type": "string"},
                        "path": {"type": "string"},
                        "content": {"type": "string"},
                    },
                    "required": ["access_token", "path", "content"],
                },
            },
            {
                "name": "append_item",
                "description": "Append text to a file in the vault and refresh its indexed chunks by file ID.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "access_token": {"type": "string"},
                        "path": {"type": "string"},
                        "content": {"type": "string"},
                    },
                    "required": ["access_token", "path", "content"],
                },
            },
            {
                "name": "move_item",
                "description": "Move a file or folder inside the vault and update the stable catalog path mapping.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "access_token": {"type": "string"},
                        "source": {"type": "string"},
                        "destination": {"type": "string"},
                    },
                    "required": ["access_token", "source", "destination"],
                },
            },
            {
                "name": "delete_item",
                "description": "Delete a file or folder from the vault and remove its indexed chunks by file ID.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "access_token": {"type": "string"},
                        "path": {"type": "string"},
                    },
                    "required": ["access_token", "path"],
                },
            },
            {
                "name": "get_item_metadata",
                "description": "Return metadata for a file or folder in the vault without reading its content.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "access_token": {"type": "string"},
                        "path": {"type": "string"},
                    },
                    "required": ["access_token", "path"],
                },
            },
            {
                "name": "list_folder_contents",
                "description": "List the immediate children of a folder in the vault.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "access_token": {"type": "string"},
                        "path": {"type": "string"},
                    },
                    "required": ["access_token", "path"],
                },
            },
            {
                "name": "exists_item",
                "description": "Check whether a file or folder exists in the vault.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "access_token": {"type": "string"},
                        "path": {"type": "string"},
                    },
                    "required": ["access_token", "path"],
                },
            },
        ]

    def authorize(self, access_token: str, required_scope: str) -> TokenClaims:
        claims = verify_token(access_token, self.revocation_path)
        require_scope(claims, required_scope)
        return claims

    def record_usage(
        self,
        *,
        claims: TokenClaims,
        tool_name: str,
        status: str,
        detail: str | None = None,
    ) -> None:
        self.usage_log_path.parent.mkdir(parents=True, exist_ok=True)
        event = {
            "timestamp": int(time.time()),
            "tenant_id": claims.tenant_id,
            "token_name": claims.token_name,
            "jti": claims.jwt_id,
            "subject": claims.subject,
            "tool": tool_name,
            "status": status,
        }
        if detail:
            event["detail"] = detail
        with self.usage_log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, sort_keys=True) + "\n")

    def handle(self, request: dict[str, Any]) -> dict[str, Any] | None:
        method = request.get("method")
        request_id = request.get("id")

        if method == "initialize":
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "serverInfo": {"name": "vault-qdrant-mcp-server", "version": "0.2.0"},
                    "capabilities": {"tools": {}},
                },
            }

        if method == "notifications/initialized":
            return None

        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": self.tools()}}

        if method == "tools/call":
            params = request.get("params") or {}
            tool_name = params.get("name")
            arguments = params.get("arguments") or {}
            result = self.call_tool(tool_name, arguments)
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {"content": [{"type": "text", "text": json.dumps(result, indent=2)}]},
            }

        raise JsonRpcError(-32601, f"Method not found: {method}")

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        access_token = arguments.get("access_token")
        if not access_token:
            raise JsonRpcError(-32602, "access_token is required")

        if name == "create_item":
            claims = self.authorize(access_token, "vault:create")
        elif name == "read_item":
            claims = self.authorize(access_token, "vault:read")
        elif name == "search_item":
            claims = self.authorize(access_token, "vault:read")
        elif name == "update_item":
            claims = self.authorize(access_token, "vault:update")
        elif name == "append_item":
            claims = self.authorize(access_token, "vault:update")
        elif name == "move_item":
            claims = self.authorize(access_token, "vault:update")
        elif name == "delete_item":
            claims = self.authorize(access_token, "vault:update")
        elif name == "get_item_metadata":
            claims = self.authorize(access_token, "vault:read")
        elif name == "list_folder_contents":
            claims = self.authorize(access_token, "vault:read")
        elif name == "exists_item":
            claims = self.authorize(access_token, "vault:read")
        else:
            raise JsonRpcError(-32601, f"Unknown tool: {name}")

        if name == "create_item":
            try:
                tenant_id = claims.tenant_id
                ctx = get_vault_context(self.base_root, tenant_id)
                create_vault(self.base_root, tenant_id)
                kind = arguments.get("kind", "file")
                path = arguments.get("path")
                content = arguments.get("content", "")
                if not path:
                    raise JsonRpcError(-32602, "path is required")
                result = create_item(
                    ctx,
                    vector_store=self.vector_store,
                    embedding_model=self.embedding_model_name,
                    kind=kind,
                    path=path,
                    content=content,
                    write_roots=claims.write_roots,
                )
                self.record_usage(claims=claims, tool_name=name, status="success")
                return result
            except Exception as exc:
                self.record_usage(claims=claims, tool_name=name, status="error", detail=str(exc))
                raise

        if name == "update_item":
            try:
                tenant_id = claims.tenant_id
                ctx = get_vault_context(self.base_root, tenant_id)
                create_vault(self.base_root, tenant_id)
                path = arguments.get("path")
                content = arguments.get("content", "")
                if not path:
                    raise JsonRpcError(-32602, "path is required")
                result = update_item(
                    ctx,
                    vector_store=self.vector_store,
                    embedding_model=self.embedding_model_name,
                    path=path,
                    content=content,
                    write_roots=claims.write_roots,
                )
                self.record_usage(claims=claims, tool_name=name, status="success")
                return result
            except Exception as exc:
                self.record_usage(claims=claims, tool_name=name, status="error", detail=str(exc))
                raise

        if name == "append_item":
            try:
                tenant_id = claims.tenant_id
                ctx = get_vault_context(self.base_root, tenant_id)
                create_vault(self.base_root, tenant_id)
                path = arguments.get("path")
                content = arguments.get("content", "")
                if not path:
                    raise JsonRpcError(-32602, "path is required")
                result = append_item(
                    ctx,
                    vector_store=self.vector_store,
                    embedding_model=self.embedding_model_name,
                    path=path,
                    content=content,
                    write_roots=claims.write_roots,
                )
                self.record_usage(claims=claims, tool_name=name, status="success")
                return result
            except Exception as exc:
                self.record_usage(claims=claims, tool_name=name, status="error", detail=str(exc))
                raise

        if name == "move_item":
            try:
                tenant_id = claims.tenant_id
                ctx = get_vault_context(self.base_root, tenant_id)
                create_vault(self.base_root, tenant_id)
                source = arguments.get("source")
                destination = arguments.get("destination")
                if not source:
                    raise JsonRpcError(-32602, "source is required")
                if not destination:
                    raise JsonRpcError(-32602, "destination is required")
                result = move_item(
                    ctx,
                    source=source,
                    destination=destination,
                    write_roots=claims.write_roots,
                )
                self.record_usage(claims=claims, tool_name=name, status="success")
                return result
            except Exception as exc:
                self.record_usage(claims=claims, tool_name=name, status="error", detail=str(exc))
                raise

        if name == "get_item_metadata":
            try:
                tenant_id = claims.tenant_id
                ctx = get_vault_context(self.base_root, tenant_id)
                create_vault(self.base_root, tenant_id)
                path = arguments.get("path")
                if not path:
                    raise JsonRpcError(-32602, "path is required")
                assert_read_allowed(path, claims.read_roots, action="metadata")
                result = get_item_metadata(ctx, path)
                self.record_usage(claims=claims, tool_name=name, status="success")
                return result
            except Exception as exc:
                self.record_usage(claims=claims, tool_name=name, status="error", detail=str(exc))
                raise

        if name == "list_folder_contents":
            try:
                tenant_id = claims.tenant_id
                ctx = get_vault_context(self.base_root, tenant_id)
                create_vault(self.base_root, tenant_id)
                path = arguments.get("path", ".")
                assert_read_allowed(path, claims.read_roots, action="list folder")
                result = list_folder_contents(ctx, path)
                self.record_usage(claims=claims, tool_name=name, status="success")
                return result
            except Exception as exc:
                self.record_usage(claims=claims, tool_name=name, status="error", detail=str(exc))
                raise

        if name == "exists_item":
            try:
                tenant_id = claims.tenant_id
                ctx = get_vault_context(self.base_root, tenant_id)
                create_vault(self.base_root, tenant_id)
                path = arguments.get("path")
                if not path:
                    raise JsonRpcError(-32602, "path is required")
                assert_read_allowed(path, claims.read_roots, action="exists check")
                result = {"path": path, "exists": path_exists(ctx, path)}
                self.record_usage(claims=claims, tool_name=name, status="success")
                return result
            except Exception as exc:
                self.record_usage(claims=claims, tool_name=name, status="error", detail=str(exc))
                raise

        if name == "delete_item":
            try:
                tenant_id = claims.tenant_id
                ctx = get_vault_context(self.base_root, tenant_id)
                create_vault(self.base_root, tenant_id)
                path = arguments.get("path")
                if not path:
                    raise JsonRpcError(-32602, "path is required")
                result = delete_item(
                    ctx,
                    vector_store=self.vector_store,
                    path=path,
                    write_roots=claims.write_roots,
                )
                self.record_usage(claims=claims, tool_name=name, status="success")
                return result
            except Exception as exc:
                self.record_usage(claims=claims, tool_name=name, status="error", detail=str(exc))
                raise

        if name == "search_item":
            try:
                tenant_id = claims.tenant_id
                ctx = get_vault_context(self.base_root, tenant_id)
                create_vault(self.base_root, tenant_id)
                request_text = arguments.get("request_text")
                top_k = int(arguments.get("top_k", 3))
                if not request_text:
                    raise JsonRpcError(-32602, "request_text is required")
                result = search_item(
                    ctx,
                    vector_store=self.vector_store,
                    request_text=request_text,
                    top_k=top_k,
                    read_roots=claims.read_roots,
                )
                self.record_usage(claims=claims, tool_name=name, status="success")
                return result
            except Exception as exc:
                self.record_usage(claims=claims, tool_name=name, status="error", detail=str(exc))
                raise

        try:
            tenant_id = claims.tenant_id
            ctx = get_vault_context(self.base_root, tenant_id)
            create_vault(self.base_root, tenant_id)
            request_text = arguments.get("request_text")
            top_k = int(arguments.get("top_k", 3))
            if not request_text:
                raise JsonRpcError(-32602, "request_text is required")
            result = read_item(
                ctx,
                vector_store=self.vector_store,
                request_text=request_text,
                top_k=top_k,
                read_roots=claims.read_roots,
            )
            self.record_usage(claims=claims, tool_name=name, status="success")
            return result
        except Exception as exc:
            self.record_usage(claims=claims, tool_name=name, status="error", detail=str(exc))
            raise


def read_mcp_message(stdin: Any) -> dict[str, Any] | None:
    headers: dict[str, str] = {}
    while True:
        line = stdin.buffer.readline()
        if not line:
            return None
        line = line.decode("utf-8").strip()
        if not line:
            break
        key, value = line.split(":", 1)
        headers[key.strip().lower()] = value.strip()

    if "content-length" not in headers:
        raise ValueError("Missing Content-Length header")

    length = int(headers["content-length"])
    payload = stdin.buffer.read(length)
    if not payload:
        return None
    return json.loads(payload.decode("utf-8"))


def write_mcp_message(stdout: Any, payload: dict[str, Any]) -> None:
    encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    stdout.buffer.write(f"Content-Length: {len(encoded)}\r\n\r\n".encode("utf-8"))
    stdout.buffer.write(encoded)
    stdout.buffer.flush()


def main() -> int:
    parser = argparse.ArgumentParser(description="Qdrant-backed vault MCP server")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="Vault base root")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    server = MCPServer(args.root)

    while True:
        try:
            request = read_mcp_message(sys.stdin)
        except Exception as exc:
            LOG.exception("Failed to read MCP message: %s", exc)
            continue

        if request is None:
            return 0

        try:
            response = server.handle(request)
            if response is not None:
                write_mcp_message(sys.stdout, response)
        except JsonRpcError as exc:
            if request.get("id") is not None:
                write_mcp_message(
                    sys.stdout,
                    {
                        "jsonrpc": "2.0",
                        "id": request.get("id"),
                        "error": {"code": exc.code, "message": exc.message, "data": exc.data},
                    },
                )
        except Exception as exc:  # pragma: no cover - unexpected runtime error
            LOG.exception("Unhandled MCP error: %s", exc)
            if request.get("id") is not None:
                write_mcp_message(
                    sys.stdout,
                    {
                        "jsonrpc": "2.0",
                        "id": request.get("id"),
                        "error": {"code": -32603, "message": f"{exc.__class__.__name__}: {exc}"},
                    },
                )


if __name__ == "__main__":
    raise SystemExit(main())
