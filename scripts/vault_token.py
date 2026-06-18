#!/usr/bin/env python3
"""Generate a signed JWT for MCP vault access."""

from __future__ import annotations

import argparse
from pathlib import Path

from vault_auth import issue_token


def main() -> int:
    parser = argparse.ArgumentParser(description="Issue a JWT for vault access")
    parser.add_argument("tenant_id")
    parser.add_argument("token_name")
    parser.add_argument("subject")
    parser.add_argument(
        "--scope",
        action="append",
        default=None,
        help="Capability scope to include; repeatable",
    )
    parser.add_argument(
        "--read-root",
        action="append",
        default=None,
        help="Relative vault path this token may read within; repeatable",
    )
    parser.add_argument(
        "--write-root",
        action="append",
        default=None,
        help="Relative vault path this token may write within; repeatable",
    )
    parser.add_argument("--ttl-days", type=int, default=365)
    parser.add_argument("--audience", default=None)
    parser.add_argument("--issuer", default=None)
    args = parser.parse_args()

    scopes = args.scope if args.scope is not None else ["vault:create", "vault:read", "vault:update"]
    token = issue_token(
        tenant_id=args.tenant_id,
        token_name=args.token_name,
        subject=args.subject,
        scopes=scopes,
        read_roots=args.read_root,
        write_roots=args.write_root,
        ttl_seconds=args.ttl_days * 24 * 60 * 60,
        audience=args.audience,
        issuer=args.issuer,
    )
    print(token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
