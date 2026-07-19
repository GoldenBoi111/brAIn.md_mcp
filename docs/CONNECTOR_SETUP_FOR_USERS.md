# Connect brAIn.md to Claude and ChatGPT

This guide is for normal users who just want to connect their brAIn.md account to Claude or ChatGPT and start using the server.

## What you need

- A brAIn.md account
- The server running at your public URL, for example `https://mcp.brain-md.dev`
- Access to Claude or ChatGPT with custom connector support

## Important URLs

Use these exact endpoints:

- MCP server: `https://mcp.brain-md.dev/mcp`
- OAuth authorize: `https://mcp.brain-md.dev/oauth/authorize`
- OAuth token: `https://mcp.brain-md.dev/oauth/token`
- OAuth registration: `https://mcp.brain-md.dev/oauth/register`

Do not use the site root as the MCP server URL. The connector needs the `/mcp` path.
Do not send local disk paths to the server. Every file and folder path must be relative to the user's vault root.

## Connecting Claude

1. Open Claude and add a new custom connector.
2. Set the remote MCP server URL to `https://mcp.brain-md.dev/mcp`.
3. If Claude asks for OAuth credentials, leave them blank unless your admin gave you a client ID and secret.
4. Save the connector.
5. Claude should open the brAIn.md sign-in page.
6. Sign in with your brAIn.md email and password.
7. Choose a token name and provider name if prompted.
8. Continue the authorization flow.

### What you should see

- A sign-in page titled `Connect Claude to brAIn.md`
- A prompt to approve the connection
- After approval, Claude should reload the available tools from the server

## Connecting ChatGPT

1. Open ChatGPT and create a new custom connector.
2. Choose OAuth client registration if the UI offers it.
3. Use the server’s discovered OAuth endpoints.
4. If the UI asks for the remote MCP server URL, use `https://mcp.brain-md.dev/mcp`.
5. If the UI shows OAuth advanced settings, let it use dynamic client registration when possible.
6. Save the connector.
7. ChatGPT will open the brAIn.md authorization page.
8. Sign in with your brAIn.md email and password.
9. Review the token name and provider name, then continue.

### If ChatGPT asks for OAuth fields

Use these values:

- Authorization URL: `https://mcp.brain-md.dev/oauth/authorize`
- Token URL: `https://mcp.brain-md.dev/oauth/token`
- Registration URL: `https://mcp.brain-md.dev/oauth/register`
- Base / issuer URL: `https://mcp.brain-md.dev`
- Scope: `mcp`

## Token name and provider name

When the login page appears, you may see two optional fields:

- Token name: a friendly label for the token, such as `Claude Web` or `ChatGPT`
- Provider name: the app name shown in the token list, such as `Claude` or `ChatGPT`

These names help you identify tokens later in the admin UI.

## How file paths should look

Correct:

```json
{
  "kind": "file",
  "path": "projects/GoldenBoi111 repo deep dives.md",
  "file_id": "dc5aea2b-dd6c-4947-a446-c8bf3bccb60c"
}
```

Incorrect:

```json
{
  "kind": "file",
  "path": "C:\\Users\\Aruntej Thummepally\\Downloads\\transfer\\brAIn.md\\vaults\\62125fb6-c362-488a-a5d6-217d8d0006c2\\projects\\GoldenBoi111 repo deep dives.md",
  "file_id": "dc5aea2b-dd6c-4947-a446-c8bf3bccb60c"
}
```

The server rejects absolute OS paths, UNC paths, and parent-directory traversal. Treat the vault root as the only root.

## What happens after you connect

After you finish sign-in and approval:

- The connector receives an OAuth token
- brAIn.md stores a token record for the connection
- The token can be viewed in the token admin page
- The connector can call the MCP tools exposed by the server

## Common mistakes

- Using the site root instead of `/mcp`
- Typing the wrong brAIn.md password
- Trying to reuse a token from another account
- Creating the connector against `localhost` when the app expects the public host
- Refreshing or closing the browser before the approval flow finishes

## If something fails

- If the connector says it cannot resolve OAuth, check that the server URL is exactly `https://mcp.brain-md.dev/mcp`
- If the browser shows a generic login or authorization error, make sure you are signed into the correct brAIn.md account
- If Claude or ChatGPT says the tools could not be loaded, remove the connector and add it again using the `/mcp` URL

## For admins

The server also supports token management from the brAIn.md UI:

- `POST /api/tokens` to create a token manually
- `GET /api/tokens` to list tokens
- `GET /api/tokens/{tokenId}` to inspect one token
- `PATCH /api/tokens/{tokenId}` to update token metadata and avatar fields
- `DELETE /api/tokens/{tokenId}` to revoke and remove a token

If you want the full API contract, see [API_REFERENCE.md](./API_REFERENCE.md).
