#!/usr/bin/env python3
"""Revoke a JWT used for MCP vault access."""

from __future__ import annotations

import argparse
from pathlib import Path

from vault_auth import TokenRevocationStore, decode_token


def main() -> int:
    parser = argparse.ArgumentParser(description="Revoke a JWT")
    parser.add_argument("token")
    parser.add_argument(
        "--revocation-path",
        default=None,
        help="Optional revocation file path; defaults to MCP_JWT_REVOCATION_PATH or ./vaults/.mcp-jwt-revocations.json",
    )
    parser.add_argument("--reason", default="manual")
    args = parser.parse_args()

    store = TokenRevocationStore(None if args.revocation_path is None else Path(args.revocation_path))
    store.revoke(decode_token(args.token), reason=args.reason)
    print("revoked")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
