#!/usr/bin/env python3
"""
brAIn.md API test suite.

Usage:
    pip install requests
    python tests/test_endpoints.py

The Next.js dev server must be running before you run this.
Start it with:  pnpm dev   (listens on http://localhost:3000)
"""

import sys
import json
import requests

BASE_URL = "http://localhost:3000/api"

# Throwaway test credentials — change if you already have a real account
TEST_EMAIL = "testuser@brain.local"
TEST_PASSWORD = "TestPass123!"
TEST_NAME = "Test User"

PASS = "\033[92m✅\033[0m"
FAIL = "\033[91m❌\033[0m"


def dump(label: str, resp: requests.Response) -> None:
    """Print a compact summary of a response."""
    try:
        body = resp.json()
    except Exception:
        body = resp.text[:200]
    icon = PASS if resp.ok else FAIL
    print(f"   {icon} {resp.status_code}  {label}")
    if not resp.ok:
        print(f"      body: {json.dumps(body, indent=6)}")


def section(title: str) -> None:
    print(f"\n{'─' * 55}")
    print(f"  {title}")
    print(f"{'─' * 55}")


# ── auth helpers ──────────────────────────────────────────────────────────────

def register_if_needed(email: str, password: str, name: str) -> None:
    """Register the test account; silently ignore 409 (already exists)."""
    r = requests.post(
        f"{BASE_URL}/auth/register",
        json={"email": email, "password": password, "name": name},
    )
    if r.status_code == 409:
        print(f"   {PASS} register — account already exists, skipping")
    else:
        dump("register", r)
        r.raise_for_status()


def login(email: str, password: str) -> requests.Session:
    """Return a Session with the brAIn session cookie set (cookie-based auth)."""
    s = requests.Session()
    r = s.post(f"{BASE_URL}/auth/login", json={"email": email, "password": password})
    dump("login", r)
    r.raise_for_status()
    user = r.json().get("user", {})
    print(f"      user: {user.get('email')}  tenant: {user.get('tenantId')}")
    return s


# ── test blocks ───────────────────────────────────────────────────────────────

def test_register_and_login() -> requests.Session:
    section("1 · Auth — register & login")
    register_if_needed(TEST_EMAIL, TEST_PASSWORD, TEST_NAME)
    return login(TEST_EMAIL, TEST_PASSWORD)


def test_me(s: requests.Session) -> None:
    section("2 · Auth — /me (session validation)")
    r = s.get(f"{BASE_URL}/auth/me")
    dump("GET /api/auth/me", r)
    r.raise_for_status()


def test_vault_tree(s: requests.Session) -> None:
    section("3 · Vault — browse root (tree view)")
    r = s.get(f"{BASE_URL}/files", params={"path": ".", "view": "tree"})
    dump("GET /api/files?path=.&view=tree", r)
    r.raise_for_status()
    data = r.json()
    print(f"      usage: {data.get('usage_bytes', 0)} / {data.get('max_bytes', 0)} bytes")
    print(f"      locked_paths: {data.get('locked_paths', [])}")


def test_file_crud(s: requests.Session) -> str:
    section("4 · Vault — file CRUD (create → read → update → append → rename → delete)")

    test_path = "test_suite/hello.txt"

    # ── Create ────────────────────────────────────────────────────────────────
    r = s.post(
        f"{BASE_URL}/files",
        json={"kind": "file", "path": test_path, "content": "Hello from the test suite!"},
    )
    dump(f"POST /api/files  (create {test_path})", r)
    r.raise_for_status()
    file_id = r.json().get("file_id")
    print(f"      file_id: {file_id}")

    # ── Read by file_id ───────────────────────────────────────────────────────
    r = s.get(f"{BASE_URL}/files/{file_id}")
    dump(f"GET /api/files/{file_id}", r)
    r.raise_for_status()
    content = r.json().get("content", "")
    assert "Hello" in content, f"Unexpected content: {content!r}"

    # ── Overwrite content ────────────────────────────────────────────────────
    r = s.put(
        f"{BASE_URL}/files/{file_id}",
        json={"content": "Overwritten by the test suite."},
    )
    dump(f"PUT /api/files/{file_id}  (overwrite)", r)
    r.raise_for_status()

    # ── Append ────────────────────────────────────────────────────────────────
    r = s.put(
        f"{BASE_URL}/files/{file_id}",
        json={"content": "\nAppended line.", "append": True},
    )
    dump(f"PUT /api/files/{file_id}  (append)", r)
    r.raise_for_status()

    # ── Rename / move ─────────────────────────────────────────────────────────
    new_path = "test_suite/hello_renamed.txt"
    r = s.put(f"{BASE_URL}/files/{file_id}", json={"path": new_path})
    dump(f"PUT /api/files/{file_id}  (rename → {new_path})", r)
    r.raise_for_status()

    return file_id


def test_folder_crud(s: requests.Session) -> None:
    section("5 · Vault — folder create")
    r = s.post(
        f"{BASE_URL}/files",
        json={"kind": "folder", "path": "test_suite/subfolder"},
    )
    dump("POST /api/files  (create folder)", r)
    r.raise_for_status()


def test_list_view(s: requests.Session) -> None:
    section("6 · Vault — list view of test_suite/")
    r = s.get(f"{BASE_URL}/files", params={"path": "test_suite", "view": "list"})
    dump("GET /api/files?path=test_suite&view=list", r)
    r.raise_for_status()


def test_embed(s: requests.Session) -> None:
    section("7 · Embedding model — generate vector via /api/embed")
    # Single text shorthand
    r = s.post(
        f"{BASE_URL}/embed",
        json={"text": "brAIn.md embedding smoke test", "include_metadata": True},
    )
    dump("POST /api/embed  (single text)", r)
    r.raise_for_status()
    body = r.json()
    print(f"      model: {body.get('model_name')}  dim: {body.get('dimension')}  vectors: {len(body.get('vectors', []))}")

    # Batch shorthand
    r2 = s.post(
        f"{BASE_URL}/embed",
        json={"texts": ["first chunk", "second chunk"]},
    )
    dump("POST /api/embed  (batch texts)", r2)
    r2.raise_for_status()
    print(f"      batch vectors returned: {len(r2.json().get('vectors', []))}")


def test_search(s: requests.Session) -> None:
    section("8 · Qdrant — semantic search via /api/search")
    r = s.post(
        f"{BASE_URL}/search",
        json={"query": "test suite hello", "top_k": 5},
    )
    dump("POST /api/search", r)
    r.raise_for_status()
    matches = r.json().get("matches", [])
    print(f"      matches returned: {len(matches)}")
    for m in matches:
        print(f"        score={m.get('score', 0):.4f}  path={m.get('relative_path')}")


def test_delete_file(s: requests.Session, file_id: str) -> None:
    section("9 · Vault — delete the renamed file")
    r = s.delete(f"{BASE_URL}/files/{file_id}")
    dump(f"DELETE /api/files/{file_id}", r)
    r.raise_for_status()

    # Confirm 404 after deletion
    r2 = s.get(f"{BASE_URL}/files/{file_id}")
    if r2.status_code == 404:
        print(f"   {PASS} 404  confirmed — file no longer exists")
    else:
        print(f"   {FAIL} expected 404 after delete, got {r2.status_code}")


def test_auth_errors() -> None:
    section("10 · Auth error cases")

    # Wrong password
    r = requests.post(
        f"{BASE_URL}/auth/login",
        json={"email": TEST_EMAIL, "password": "wrong_password"},
    )
    if r.status_code in (400, 401, 403):
        print(f"   {PASS} {r.status_code}  wrong-password rejected correctly")
    else:
        dump("wrong password (expected 4xx)", r)

    # Unauthenticated access to /api/files
    r = requests.get(f"{BASE_URL}/files")
    if r.status_code in (401, 403):
        print(f"   {PASS} {r.status_code}  unauthenticated /api/files blocked correctly")
    else:
        dump("unauth /api/files (expected 401/403)", r)

    # Unauthenticated /api/search
    r = requests.post(f"{BASE_URL}/search", json={"query": "hello"})
    if r.status_code in (401, 403):
        print(f"   {PASS} {r.status_code}  unauthenticated /api/search blocked correctly")
    else:
        dump("unauth /api/search (expected 401/403)", r)


def test_logout(s: requests.Session) -> None:
    section("11 · Auth — logout")
    r = s.post(f"{BASE_URL}/auth/logout")
    dump("POST /api/auth/logout", r)

    # Session should now be invalid
    r2 = s.get(f"{BASE_URL}/auth/me")
    if r2.status_code in (401, 403):
        print(f"   {PASS} {r2.status_code}  session invalidated after logout")
    else:
        dump("/auth/me after logout (expected 401/403)", r2)


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    print("\n🧪  brAIn.md API test suite")
    print(f"    base URL : {BASE_URL}")
    print(f"    test user: {TEST_EMAIL}")

    failed = False
    session = None
    file_id = None

    try:
        session = test_register_and_login()
        test_me(session)
        test_vault_tree(session)
        file_id = test_file_crud(session)
        test_folder_crud(session)
        test_list_view(session)
        test_embed(session)
        test_search(session)
        if file_id:
            test_delete_file(session, file_id)
        test_auth_errors()
        if session:
            test_logout(session)
    except Exception as exc:
        print(f"\n{FAIL}  Test run aborted: {exc}")
        failed = True

    print("\n" + ("=" * 55))
    if failed:
        print("  Some tests failed — see output above.")
    else:
        print("  All tests passed.")
    print("=" * 55 + "\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
