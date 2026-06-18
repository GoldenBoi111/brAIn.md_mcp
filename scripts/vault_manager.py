#!/usr/bin/env python3
"""Local-first vault manager for user-owned folder trees.

This tool keeps each user's vault inside a dedicated root folder and enforces
path sandboxing so operations cannot escape that vault. Folder locks are stored
in a small JSON manifest inside the vault and are checked on every operation.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from vault_catalog import (
    ensure_file_id,
    remove_path,
    rename_path,
    get_file_id_for_path,
)


DEFAULT_ROOT = Path.cwd() / "vaults"
LOCK_FILE_NAME = ".vault-locks.json"
MAX_VAULT_BYTES = 100 * 1024 * 1024
CATALOG_FILE_NAME = ".vault-index.json"


class VaultError(RuntimeError):
    pass


def normalize_rel_path(value: str) -> Path:
    raw = value.strip().replace("\\", "/")
    if not raw or raw == ".":
        return Path(".")
    if raw.startswith("/"):
        raise VaultError("Paths must be relative to the vault root")
    path = Path(raw)
    if any(part == ".." for part in path.parts):
        raise VaultError("Parent directory references are not allowed")
    return path


def within_root(root: Path, candidate: Path) -> Path:
    root = root.resolve()
    candidate = candidate.resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise VaultError(f"Path escapes vault root: {candidate}") from exc
    return candidate


def load_lock_manifest(vault_root: Path) -> set[str]:
    lock_file = vault_root / LOCK_FILE_NAME
    if not lock_file.exists():
        return set()
    data = json.loads(lock_file.read_text(encoding="utf-8"))
    locked = data.get("locked_paths", [])
    return {str(item) for item in locked}


def get_vault_usage_bytes(vault_root: Path) -> int:
    total = 0
    for path in vault_root.rglob("*"):
        if not path.is_file():
            continue
        if path.name in {LOCK_FILE_NAME, ".vault.json", CATALOG_FILE_NAME}:
            continue
        total += path.stat().st_size
    return total


def save_lock_manifest(vault_root: Path, locked_paths: Iterable[str]) -> None:
    lock_file = vault_root / LOCK_FILE_NAME
    payload = {
        "locked_paths": sorted({str(path).replace("\\", "/") for path in locked_paths}),
    }
    lock_file.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


@dataclass(frozen=True)
class VaultContext:
    root: Path
    vault_root: Path
    locks: set[str]

    @property
    def root_display(self) -> str:
        return str(self.vault_root)

    def rel(self, value: str) -> Path:
        rel = normalize_rel_path(value)
        target = self.vault_root / rel
        return within_root(self.vault_root, target)

    def rel_key(self, value: str) -> str:
        rel = normalize_rel_path(value)
        return "." if rel == Path(".") else rel.as_posix()

    def is_locked(self, rel_key: str) -> bool:
        rel_key = "." if rel_key == "" else rel_key
        if rel_key == ".":
            return "." in self.locks or "" in self.locks
        parts = Path(rel_key).parts
        prefix = Path()
        for part in parts:
            prefix = prefix / part
            if prefix.as_posix() in self.locks or "." in self.locks:
                return True
        return False

    def assert_unlocked(self, rel_key: str) -> None:
        if self.is_locked(rel_key):
            raise VaultError(f"Path is locked: {rel_key}")


def get_vault_context(base_root: Path, user_id: str) -> VaultContext:
    base_root = base_root.resolve()
    vault_root = within_root(base_root, base_root / user_id)
    vault_root.mkdir(parents=True, exist_ok=True)
    locks = load_lock_manifest(vault_root)
    return VaultContext(root=base_root, vault_root=vault_root, locks=locks)


def create_vault(base_root: Path, user_id: str, display_name: str | None = None) -> Path:
    ctx = get_vault_context(base_root, user_id)
    root_marker = ctx.vault_root / ".vault.json"
    if not root_marker.exists():
        payload = {
            "user_id": user_id,
            "display_name": display_name or "Vault",
        }
        root_marker.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    save_lock_manifest(ctx.vault_root, ctx.locks)
    return ctx.vault_root


def list_tree(start: Path, prefix: str = "") -> list[str]:
    entries: list[str] = []
    items = sorted(start.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    for item in items:
        if item.name in {LOCK_FILE_NAME, ".vault.json", CATALOG_FILE_NAME}:
            continue
        label = f"{prefix}{item.name}"
        if item.is_dir():
            entries.append(f"{label}/")
            entries.extend(list_tree(item, prefix=f"{label}/"))
        else:
            entries.append(label)
    return entries


def ensure_parent_exists(path: Path) -> None:
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)


def lock_path(ctx: VaultContext, relative: str) -> str:
    rel_key = ctx.rel_key(relative)
    ctx.locks.add(rel_key)
    save_lock_manifest(ctx.vault_root, ctx.locks)
    return rel_key


def unlock_path(ctx: VaultContext, relative: str) -> str:
    rel_key = ctx.rel_key(relative)
    ctx.locks.discard(rel_key)
    save_lock_manifest(ctx.vault_root, ctx.locks)
    return rel_key


def create_folder(ctx: VaultContext, relative: str) -> Path:
    rel_key = ctx.rel_key(relative)
    ctx.assert_unlocked(rel_key)
    target = ctx.rel(relative)
    ensure_parent_exists(target)
    target.mkdir(exist_ok=True)
    return target


def write_file(ctx: VaultContext, relative: str, content: str) -> Path:
    rel_key = ctx.rel_key(relative)
    ctx.assert_unlocked(rel_key)
    target = ctx.rel(relative)
    ensure_parent_exists(target)

    current_usage = get_vault_usage_bytes(ctx.vault_root)
    current_size = target.stat().st_size if target.exists() and target.is_file() else 0
    proposed_size = len(content.encode("utf-8"))
    proposed_usage = current_usage - current_size + proposed_size
    if proposed_usage > MAX_VAULT_BYTES:
        raise VaultError(
            f"Vault size limit exceeded: {proposed_usage} bytes would exceed "
            f"{MAX_VAULT_BYTES} bytes"
        )

    target.write_text(content, encoding="utf-8")
    ensure_file_id(ctx.vault_root, rel_key)
    return target


def append_file(ctx: VaultContext, relative: str, content: str) -> Path:
    rel_key = ctx.rel_key(relative)
    ctx.assert_unlocked(rel_key)
    target = ctx.rel(relative)
    ensure_parent_exists(target)

    current_text = target.read_text(encoding="utf-8") if target.exists() and target.is_file() else ""
    combined = current_text + content

    current_usage = get_vault_usage_bytes(ctx.vault_root)
    current_size = target.stat().st_size if target.exists() and target.is_file() else 0
    proposed_size = len(combined.encode("utf-8"))
    proposed_usage = current_usage - current_size + proposed_size
    if proposed_usage > MAX_VAULT_BYTES:
        raise VaultError(
            f"Vault size limit exceeded: {proposed_usage} bytes would exceed "
            f"{MAX_VAULT_BYTES} bytes"
        )

    target.write_text(combined, encoding="utf-8")
    ensure_file_id(ctx.vault_root, rel_key)
    return target


def read_file(ctx: VaultContext, relative: str) -> str:
    rel_key = ctx.rel_key(relative)
    ctx.assert_unlocked(rel_key)
    target = ctx.rel(relative)
    if not target.is_file():
        raise VaultError(f"File does not exist: {relative}")
    return target.read_text(encoding="utf-8")


def path_exists(ctx: VaultContext, relative: str) -> bool:
    rel_key = ctx.rel_key(relative)
    target = ctx.rel(relative)
    return target.exists()


def get_item_metadata(ctx: VaultContext, relative: str) -> dict[str, object]:
    rel_key = ctx.rel_key(relative)
    target = ctx.rel(relative)
    if not target.exists():
        raise VaultError(f"Path does not exist: {relative}")

    stat = target.stat()
    kind = "folder" if target.is_dir() else "file"
    file_id = get_file_id_for_path(ctx.vault_root, rel_key) if kind == "file" else None
    return {
        "relative_path": rel_key,
        "file_location": str(target.resolve()),
        "kind": kind,
        "exists": True,
        "locked": ctx.is_locked(rel_key),
        "size_bytes": stat.st_size if target.is_file() else None,
        "created_at": int(stat.st_ctime),
        "modified_at": int(stat.st_mtime),
        "file_id": file_id,
    }


def list_folder_contents(ctx: VaultContext, relative: str = ".") -> list[dict[str, object]]:
    rel_key = ctx.rel_key(relative)
    target = ctx.rel(relative)
    if not target.exists():
        raise VaultError(f"Path does not exist: {relative}")
    if not target.is_dir():
        raise VaultError(f"Path is not a folder: {relative}")

    entries: list[dict[str, object]] = []
    for item in sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
        if item.name in {LOCK_FILE_NAME, ".vault.json", CATALOG_FILE_NAME}:
            continue
        item_key = "." if item == ctx.vault_root else item.relative_to(ctx.vault_root).as_posix()
        entries.append(
            {
                "name": item.name,
                "relative_path": item_key,
                "kind": "folder" if item.is_dir() else "file",
                "locked": ctx.is_locked(item_key),
                "file_id": get_file_id_for_path(ctx.vault_root, item_key) if item.is_file() else None,
                "size_bytes": item.stat().st_size if item.is_file() else None,
                "modified_at": int(item.stat().st_mtime),
            }
        )
    return entries


def delete_path(ctx: VaultContext, relative: str) -> Path:
    rel_key = ctx.rel_key(relative)
    if rel_key == ".":
        raise VaultError("Cannot delete the vault root")
    ctx.assert_unlocked(rel_key)
    target = ctx.rel(relative)
    if target.is_dir():
        shutil.rmtree(target)
    elif target.exists():
        target.unlink()
    else:
        raise VaultError(f"Path does not exist: {relative}")
    remove_path(ctx.vault_root, rel_key)
    return target


def move_path(ctx: VaultContext, source: str, destination: str) -> tuple[Path, Path]:
    source_key = ctx.rel_key(source)
    dest_key = ctx.rel_key(destination)
    if source_key == "." or dest_key == ".":
        raise VaultError("Cannot move the vault root")
    ctx.assert_unlocked(source_key)
    ctx.assert_unlocked(dest_key)
    src = ctx.rel(source)
    dst = ctx.rel(destination)
    ensure_parent_exists(dst)
    src.rename(dst)
    rename_path(ctx.vault_root, source_key, dest_key)
    return src, dst


def render_tree(ctx: VaultContext) -> str:
    lines = [f"Vault: {ctx.vault_root}"]
    lines.extend(list_tree(ctx.vault_root))
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage a local-first vault tree")
    parser.add_argument(
        "--root",
        type=Path,
        default=DEFAULT_ROOT,
        help="Base directory that holds all user vaults",
    )

    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init-vault", help="Create a vault root for a user")
    p_init.add_argument("user_id")
    p_init.add_argument("--name", default="Vault")

    p_tree = sub.add_parser("tree", help="Print a vault tree")
    p_tree.add_argument("user_id")

    p_mkdir = sub.add_parser("mkdir", help="Create a folder in the vault")
    p_mkdir.add_argument("user_id")
    p_mkdir.add_argument("path")

    p_write = sub.add_parser("write", help="Write a file in the vault")
    p_write.add_argument("user_id")
    p_write.add_argument("path")
    p_write.add_argument("content")

    p_read = sub.add_parser("read", help="Read a file from the vault")
    p_read.add_argument("user_id")
    p_read.add_argument("path")

    p_rm = sub.add_parser("rm", help="Delete a file or folder")
    p_rm.add_argument("user_id")
    p_rm.add_argument("path")

    p_mv = sub.add_parser("mv", help="Move a file or folder")
    p_mv.add_argument("user_id")
    p_mv.add_argument("source")
    p_mv.add_argument("destination")

    p_lock = sub.add_parser("lock", help="Lock a path")
    p_lock.add_argument("user_id")
    p_lock.add_argument("path")

    p_unlock = sub.add_parser("unlock", help="Unlock a path")
    p_unlock.add_argument("user_id")
    p_unlock.add_argument("path")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    root = args.root.resolve()

    try:
        if args.command == "init-vault":
            path = create_vault(root, args.user_id, args.name)
            print(path)
            return 0

        ctx = get_vault_context(root, args.user_id)

        if args.command == "tree":
            print(render_tree(ctx))
            return 0

        if args.command == "mkdir":
            print(create_folder(ctx, args.path))
            return 0

        if args.command == "write":
            print(write_file(ctx, args.path, args.content))
            return 0

        if args.command == "read":
            print(read_file(ctx, args.path))
            return 0

        if args.command == "rm":
            print(delete_path(ctx, args.path))
            return 0

        if args.command == "mv":
            src, dst = move_path(ctx, args.source, args.destination)
            print(f"{src} -> {dst}")
            return 0

        if args.command == "lock":
            print(lock_path(ctx, args.path))
            return 0

        if args.command == "unlock":
            print(unlock_path(ctx, args.path))
            return 0

        parser.error("Unknown command")
        return 2
    except VaultError as exc:
        parser.exit(1, f"error: {exc}\n")


if __name__ == "__main__":
    raise SystemExit(main())
