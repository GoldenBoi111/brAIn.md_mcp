# Vault Manager Scripts

This folder contains the first-pass local-first vault tooling.

## What it does

- Creates a per-user vault root on disk
- Creates folders and files inside that vault
- Prevents path traversal outside the vault root
- Tracks locked paths in a JSON manifest
- Tracks stable file IDs in a local catalog so file moves do not force vector reindexing
- Enforces a 100 MB per-vault size limit
- Supports basic tree listing, reads, writes, moves, and deletes
- Provides a Qdrant-backed MCP server for semantic create/read routing
- MCP tools now cover create, read, search, update, append, move, delete, metadata, list, and existence checks

## Example usage

```bash
python scripts/vault_manager.py setup user-123 --name "Arun Vault"
python scripts/vault_manager.py init-vault user-123 --name "Arun Vault"
python scripts/vault_manager.py tree user-123
python scripts/vault_manager.py status user-123
python scripts/vault_manager.py locks user-123
python scripts/vault_manager.py mkdir user-123 Projects/Notes
python scripts/vault_manager.py write user-123 Projects/Notes/todo.md "Hello from the vault"
python scripts/vault_manager.py lock user-123 Projects/Notes
python scripts/vault_token.py user-123 claude-main alice@example.com
python scripts/vault_revoke.py <jwt-token>
python scripts/mcp_qdrant_server.py --root ./vaults
```

## Notes

- This is app-level locking, not OS ACL hardening yet.
- If you want, we can add OS permission enforcement next for Windows or Linux.
- Use `setup` for a one-command vault bootstrap that also prints the initial status.
- Set `QDRANT_URL` and `JASPER_EMBEDDER_URL` before starting the MCP server.
- Set `MCP_JWT_SECRET` and, if you want a custom path, `MCP_JWT_REVOCATION_PATH`.
- Usage events are appended to `MCP_USAGE_LOG_PATH` so you can track token usage by `jti` and `token_name`.
- JWTs default to a 365-day lifetime so users do not need to reconfigure clients often.
- Tokens default to `vault:create`, `vault:read`, and `vault:update` scopes.
- Use `--read-root` and `--write-root` with `vault_token.py` to restrict a token's read and write areas independently.
- If only one side is set, the issuer copies it to the other side so the token stays scoped.
- Qdrant now stores `file_id` values rather than file paths; the vault catalog maps each `file_id` to the current path on disk.
