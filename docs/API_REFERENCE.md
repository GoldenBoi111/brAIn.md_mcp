# brAIn.md MCP Server API Reference

This document covers the implemented HTTP, OAuth, and MCP surfaces in the current server.

Base URL examples:

- Local development: `http://localhost:3000`
- Tunnel / public host: `https://mcp.brain-md.dev`

## Authentication Models

The server uses three auth layers:

1. Session cookie auth for the human-facing API
2. Bearer JWT auth for the MCP endpoint
3. OAuth authorization-code flow for ChatGPT / Claude web connectors

### Session Cookie

Used by most `/api/*` routes.

- Cookie name: `brain_session`
- Created by:
  - `POST /api/auth/register`
  - `POST /api/auth/login`
- Cleared by:
  - `POST /api/auth/logout`

### MCP Bearer Token

Used by `POST /mcp`.

- A signed JWT issued by:
  - `POST /api/mcp/token`
  - `POST /api/tokens`
  - `POST /oauth/token`
- Token claims include:
  - `tenantId`
  - `tokenName`
  - `subject`
  - `email`
  - `scopes`
  - `readRoots`
  - `writeRoots`
  - `jwtId`
  - `issuer`
  - `audience`

### OAuth Connector Flow

Used by ChatGPT and Claude web.

Discovery endpoints:

- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/openid-configuration`
- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-protected-resource/{resource}`
- `GET /.well-known/mcp.json`

OAuth endpoints:

- `POST /oauth/register`
- `GET /oauth/authorize`
- `POST /oauth/token`
- `GET /oauth/userinfo`

## Implemented HTTP API

### `GET /api`

Returns the top-level API index and route list.

Response fields:

- `name`
- `api_version`
- `versioned_root`
- `routes`

### `GET /api/health`

Returns app health and dependency status.

Response fields:

- `status`
- `api_version`
- `services`

`services` currently includes:

- `api`
- `auth`
- `vault`
- `qdrant`
- `embedder`

### `GET /api/openapi`

Returns the generated OpenAPI 3.1 document for the backend API.

### Auth

#### `POST /api/auth/register`

Create a local auth user and return a session cookie.

Request body:

```json
{
  "email": "user@example.com",
  "password": "password123",
  "name": "Optional display name",
  "role": "admin"
}
```

Response:

```json
{ "user": { "...": "..." } }
```

#### `POST /api/auth/login`

Authenticate a local auth user and return a session cookie.

Request body:

```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

#### `POST /api/auth/logout`

Clears the session cookie.

#### `GET /api/auth/me`

Returns the current session claims.

Response:

```json
{ "user": { "...session claims..." } }
```

### Users

#### `GET /api/users`

List local auth users.

Auth:

- session cookie
- admin only

#### `POST /api/users`

Create a local auth user.

Auth:

- session cookie
- admin only

Request body matches `POST /api/auth/register`.

### Tokens

#### `GET /api/tokens`

List MCP tokens for the current tenant.

Response includes:

- `token_id`
- `tenant_id`
- `token_name`
- `subject`
- `source`
- `provider_name`
- `created_by`
- `oauth_client_id`
- `oauth_client_name`
- `description`
- `avatar_url`
- `avatar_alt`
- `avatar_background`
- `scopes`
- `read_roots`
- `write_roots`
- `locked_paths`
- `created_at`
- `updated_at`
- `expires_at`
- `last_used_at`
- `revoked_at`

#### `POST /api/tokens`

Issue a new MCP token for the current tenant.

Request body:

```json
{
  "tokenName": "Claude Web",
  "subject": "user-id-or-label",
  "scopes": ["mcp"],
  "readRoots": ["."],
  "writeRoots": ["."],
  "ttlDays": 365,
  "issuer": "brAIn-mcp",
  "audience": "brAIn-mcp",
  "providerName": "Claude",
  "description": "Primary Claude bridge token",
  "avatarUrl": "https://example.com/avatar.png",
  "avatarAlt": "Claude logo",
  "avatarBackground": "#111827"
}
```

Response:

```json
{
  "api_version": "v1",
  "tenant_id": "...",
  "token_id": "...",
  "token_name": "...",
  "token": "eyJ..."
}
```

#### `GET /api/tokens/{tokenId}`

Fetch a single token record.

#### `PATCH /api/tokens/{tokenId}`

Update token metadata or visual identity.

Request body supports:

- `tokenName`
- `providerName`
- `description`
- `avatarUrl`
- `avatarAlt`
- `avatarBackground`
- `revoked`

#### `DELETE /api/tokens/{tokenId}`

Revoke and remove a token record.

### MCP Token Route

#### `POST /api/mcp/token`

Creates a token using the current session. This is a compatibility route for the MCP token flow.

Request body fields:

- `tokenName`
- `subject`
- `scopes`
- `readRoots`
- `writeRoots`
- `ttlDays`
- `issuer`
- `audience`

Response:

```json
{
  "route": "/api/mcp/token"
}
```

The actual POST response returns:

- `token`
- `token_id`
- `token_name`
- `tenant_id`

### Vault

#### `GET /api/vault/usage`

Returns vault usage and size limits for the current tenant.

Query params:

- `path` defaults to `.`
- `view` defaults to `tree`

Response:

- `api_version`
- `tenant_id`
- `path`
- `view`
- `usage_bytes`
- `max_bytes`

#### `GET /api/vault/locks`

List tenant vault locks visible to the current session.

Query params:

- `path`
- `file_id`
- `folder_id`

#### `POST /api/vault/locks`

Lock one or more vault paths.

Request body supports:

- `path`
- `paths`
- `file_id`
- `file_ids`
- `folder_id`
- `folder_ids`

#### `DELETE /api/vault/locks`

Unlock one or more vault paths.

Request body supports:

- `path`
- `paths`
- `file_id`
- `file_ids`
- `folder_id`
- `folder_ids`

#### `POST /api/vault/reindex`

Rebuild embeddings for a vault subtree.

Request body:

```json
{
  "path": ".",
  "embedding_model": "jasper-token-compression-600m"
}
```

### Files

#### `GET /api/files`

Return a tree or flat listing for a vault path.

Query params:

- `path` defaults to `.`
- `view` defaults to `tree`

Response includes:

- `tenant_id`
- `path`
- `view`
- `locked_paths`
- `usage_bytes`
- `max_bytes`
- `data`

`data` items now include:

- `fileId` for files
- `folderId` for folders
- alias fields `file_id` and `folder_id` are also present on tree/list items

#### `POST /api/files`

Create a file or folder.

Request body:

```json
{
  "kind": "file",
  "path": "notes/example.md",
  "content": "hello",
  "embedding_model": "jasper-token-compression-600m"
}
```

Response:

- file create returns `file_id` and `folder_id: null`
- folder create returns `folder_id` and `file_id: null`

#### `GET /api/files/{id}`

Fetch a file or folder by stable `file_id` or `folder_id`.

#### `PUT /api/files/{id}`

Move or edit a file or folder by stable `file_id` or `folder_id`.

#### `DELETE /api/files/{id}`

Delete a file or folder by stable `file_id` or `folder_id`.

### Search

#### `GET /api/search`

Describes the search endpoint request format.

#### `POST /api/search`

Run semantic search against the tenant vault.

Request body:

```json
{
  "query": "find my meeting notes",
  "top_k": 10
}
```

Response includes:

- `tenant_id`
- `query`
- `top_k`
- `matches`

### Embedding

#### `GET /api/embed`

Describes the embedding endpoint request format.

#### `POST /api/embed`

Embed one or more texts and return vectors.

Request body:

```json
{
  "text": "single string",
  "texts": ["one", "two"],
  "include_metadata": true
}
```

## OAuth / Connector Surface

### `POST /oauth/register`

Dynamic client registration.

Request body example:

```json
{
  "client_name": "Claude",
  "redirect_uris": ["https://chatgpt.com/connector/oauth/callback"],
  "token_endpoint_auth_method": "client_secret_basic"
}
```

Important response fields:

- `client_id`
- `client_secret`
- `client_name`
- `redirect_uris`
- `grant_types`
- `response_types`
- `token_endpoint_auth_method`
- `client_id_issued_at`
- `client_secret_expires_at`
- `registration_client_uri`

### `GET /oauth/authorize`

Starts the authorization code flow.

Required query params:

- `response_type=code`
- `client_id`
- `redirect_uri`
- `scope`
- `code_challenge`
- `code_challenge_method`
- `state`

Optional UI metadata params:

- `token_name`
- `provider_name`

If the request arrives without an authenticated session, the route returns an HTML login page.

### `POST /oauth/token`

Exchanges an authorization code for a bearer token.

Supported grant:

- `authorization_code`

Auth methods:

- `client_secret_basic`
- `client_secret_post`
- `none`

Response fields:

- `access_token`
- `token_type`
- `expires_in`
- `scope`
- `tenant_id`
- `token_id`
- `token_name`
- `provider_name`

### `GET /oauth/userinfo`

Returns the authenticated user profile for OIDC.

Response fields:

- `sub`
- `email`
- `name`
- `tenant_id`

## Well-Known Discovery

### `GET /.well-known/oauth-authorization-server`

Returns OAuth authorization server metadata.

Advertises:

- issuer
- authorization endpoint
- token endpoint
- registration endpoint
- response types
- grant types
- PKCE support
- token auth methods
- supported scopes

### `GET /.well-known/openid-configuration`

Returns OIDC discovery metadata.

### `GET /.well-known/oauth-protected-resource`

Returns protected resource metadata for the server.

### `GET /.well-known/oauth-protected-resource/{resource}`

Returns protected resource metadata for a specific MCP resource, such as `mcp`.

### `GET /.well-known/mcp.json`

Returns the MCP app descriptor:

- `name`
- `version`
- `transport`
- `mcp_endpoint`
- `authorization_server`

## MCP Endpoint

### `GET /mcp`

Returns a small descriptor saying the route accepts POST JSON-RPC requests.

### `POST /mcp`

JSON-RPC over HTTP with a bearer token.

Supported methods:

- `initialize`
- `notifications/initialized`
- `ping`
- `tools/list`
- `tools/call`
- `resources/list`
- `prompts/list`

Unknown methods return JSON-RPC `method not found`.

#### `initialize`

Returns:

- `protocolVersion`
- `serverInfo`
- `capabilities`

#### `tools/list`

Returns the full tool list with input schemas.

Implemented tools:

- `create_item`
- `read_item`
- `search_item`
- `update_item`
- `append_item`
- `move_item`
- `delete_item`
- `get_item_metadata`
- `list_folder_contents`
- `exists_item`

#### `tools/call`

Parameters:

- `name`
- `arguments`

Tool behavior is tenant-scoped and token-scoped.

## Storage Locations

### User Auth

- `./.auth/users.json`

### OAuth Clients and Authorization Codes

- `./.auth/claude-oauth.json`

### Vaults

- `./vaults/<tenantId>/...`

### Vault Root Metadata

- `./vaults/<tenantId>/.vault.json`

### Vault Locks

- `./vaults/<tenantId>/.vault-locks.json`

### Token Lock Registry

- `./vaults/.mcp-token-locks.json`

### JWT Revocations

- `./vaults/.mcp-jwt-revocations.json`

## Common Status Codes

- `200` success
- `201` created
- `204` no content
- `307` redirect
- `400` bad request
- `401` unauthorized
- `403` forbidden
- `404` not found
- `409` conflict
- `413` payload too large
- `423` locked
- `500` server error
- `502` upstream dependency error
