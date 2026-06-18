#!/usr/bin/env python3
"""Stable file identity catalog for local vaults.

The filesystem remains the source of truth for file contents, while this
catalog keeps a stable `file_id` for each file and a path lookup table that
can be updated cheaply when files or folders move.
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any


CATALOG_FILE_NAME = ".vault-index.json"


def _atomic_write(path: Path, payload: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(payload, encoding="utf-8")
    tmp_path.replace(path)


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _normalize_path(value: str) -> str:
    raw = value.strip().replace("\\", "/")
    if not raw or raw == ".":
        return "."
    if raw.startswith("/"):
        raise ValueError("paths must be relative")
    parts = [part for part in raw.split("/") if part]
    if any(part == ".." for part in parts):
        raise ValueError("paths cannot contain ..")
    return "/".join(parts)


def _is_child_path(path: str, prefix: str) -> bool:
    if path == prefix:
        return True
    return path.startswith(prefix + "/")


def _catalog_path(vault_root: Path) -> Path:
    return vault_root / CATALOG_FILE_NAME


def load_catalog(vault_root: Path) -> dict[str, Any]:
    data = _read_json(_catalog_path(vault_root))
    files = data.get("files", {})
    paths = data.get("paths", {})
    if not isinstance(files, dict) or not isinstance(paths, dict):
        return {"files": {}, "paths": {}, "updated_at": int(time.time())}
    return {
        "files": files,
        "paths": paths,
        "updated_at": int(data.get("updated_at", time.time())),
    }


def save_catalog(vault_root: Path, catalog: dict[str, Any]) -> None:
    payload = {
        "files": catalog.get("files", {}),
        "paths": catalog.get("paths", {}),
        "updated_at": int(time.time()),
    }
    _atomic_write(_catalog_path(vault_root), json.dumps(payload, indent=2, sort_keys=True) + "\n")


def create_file_record(vault_root: Path, relative_path: str) -> str:
    relative_path = _normalize_path(relative_path)
    catalog = load_catalog(vault_root)
    paths = catalog.setdefault("paths", {})
    files = catalog.setdefault("files", {})

    if relative_path in paths:
        raise ValueError(f"File already exists in catalog: {relative_path}")

    file_id = str(uuid.uuid4())
    now = int(time.time())
    files[file_id] = {
        "path": relative_path,
        "created_at": now,
        "updated_at": now,
    }
    paths[relative_path] = file_id
    save_catalog(vault_root, catalog)
    return file_id


def ensure_file_id(vault_root: Path, relative_path: str) -> str:
    relative_path = _normalize_path(relative_path)
    catalog = load_catalog(vault_root)
    paths = catalog.setdefault("paths", {})
    files = catalog.setdefault("files", {})

    file_id = paths.get(relative_path)
    if isinstance(file_id, str) and file_id in files:
        return file_id

    return create_file_record(vault_root, relative_path)


def get_file_id_for_path(vault_root: Path, relative_path: str) -> str | None:
    relative_path = _normalize_path(relative_path)
    catalog = load_catalog(vault_root)
    file_id = catalog.get("paths", {}).get(relative_path)
    return str(file_id) if isinstance(file_id, str) else None


def get_path_for_file_id(vault_root: Path, file_id: str) -> str | None:
    catalog = load_catalog(vault_root)
    record = catalog.get("files", {}).get(file_id)
    if not isinstance(record, dict):
        return None
    path = record.get("path")
    return str(path) if isinstance(path, str) else None


def set_file_path(vault_root: Path, file_id: str, relative_path: str) -> None:
    relative_path = _normalize_path(relative_path)
    catalog = load_catalog(vault_root)
    files = catalog.setdefault("files", {})
    paths = catalog.setdefault("paths", {})
    record = files.get(file_id)
    if not isinstance(record, dict):
        raise KeyError(f"Unknown file_id: {file_id}")

    old_path = record.get("path")
    if isinstance(old_path, str) and old_path in paths:
        if paths.get(old_path) == file_id:
            del paths[old_path]

    record["path"] = relative_path
    record["updated_at"] = int(time.time())
    paths[relative_path] = file_id
    save_catalog(vault_root, catalog)


def remove_path(vault_root: Path, relative_path: str) -> None:
    relative_path = _normalize_path(relative_path)
    catalog = load_catalog(vault_root)
    files = catalog.setdefault("files", {})
    paths = catalog.setdefault("paths", {})

    if relative_path == ".":
        return

    affected_ids: list[str] = []
    for file_id, record in list(files.items()):
        if not isinstance(record, dict):
            continue
        path = record.get("path")
        if isinstance(path, str) and _is_child_path(path, relative_path):
            affected_ids.append(file_id)

    for file_id in affected_ids:
        record = files.pop(file_id, None)
        if isinstance(record, dict):
            path = record.get("path")
            if isinstance(path, str) and paths.get(path) == file_id:
                del paths[path]

    save_catalog(vault_root, catalog)


def rename_path(vault_root: Path, old_relative_path: str, new_relative_path: str) -> None:
    old_relative_path = _normalize_path(old_relative_path)
    new_relative_path = _normalize_path(new_relative_path)
    catalog = load_catalog(vault_root)
    files = catalog.setdefault("files", {})
    paths = catalog.setdefault("paths", {})

    affected: list[tuple[str, str]] = []
    for file_id, record in files.items():
        if not isinstance(record, dict):
            continue
        path = record.get("path")
        if not isinstance(path, str):
            continue
        if _is_child_path(path, old_relative_path):
            suffix = path[len(old_relative_path) :]
            suffix = suffix[1:] if suffix.startswith("/") else suffix
            updated = new_relative_path if suffix == "" else f"{new_relative_path}/{suffix}"
            affected.append((file_id, updated))

    for file_id, updated_path in affected:
        record = files[file_id]
        old_path = record.get("path")
        if isinstance(old_path, str) and paths.get(old_path) == file_id:
            del paths[old_path]
        record["path"] = updated_path
        record["updated_at"] = int(time.time())
        paths[updated_path] = file_id

    save_catalog(vault_root, catalog)


def list_file_ids_under_path(vault_root: Path, relative_path: str) -> list[str]:
    relative_path = _normalize_path(relative_path)
    catalog = load_catalog(vault_root)
    files = catalog.get("files", {})
    if not isinstance(files, dict):
        return []

    file_ids: list[str] = []
    for file_id, record in files.items():
        if not isinstance(record, dict):
            continue
        path = record.get("path")
        if isinstance(path, str) and _is_child_path(path, relative_path):
            file_ids.append(str(file_id))
    return file_ids


def list_paths_under_path(vault_root: Path, relative_path: str) -> list[str]:
    relative_path = _normalize_path(relative_path)
    catalog = load_catalog(vault_root)
    files = catalog.get("files", {})
    if not isinstance(files, dict):
        return []

    paths: list[str] = []
    for record in files.values():
        if not isinstance(record, dict):
            continue
        path = record.get("path")
        if isinstance(path, str) and _is_child_path(path, relative_path):
            paths.append(path)
    return paths
