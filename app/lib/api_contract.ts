export const API_VERSION = "v1";
export const API_TITLE = "brAIn.md MCP Server API";
export const API_DESCRIPTION = "Local-first backend API for auth, vaults, tokens, and MCP support.";

type Schema = Record<string, unknown>;

function objectSchema(properties: Record<string, Schema>, required: string[] = [], title?: string): Schema {
	return {
		type: "object",
		...(title ? { title } : {}),
		properties,
		required,
		additionalProperties: false,
	};
}

function arraySchema(items: Schema, title?: string): Schema {
	return {
		type: "array",
		...(title ? { title } : {}),
		items,
	};
}

function response(contentSchema: Schema, description = "Success"): Schema {
	return {
		description,
		content: {
			"application/json": {
				schema: contentSchema,
			},
		},
	};
}

function pathItem(summary: string, description: string, tags: string[], requestBody?: Schema, responses?: Record<string, Schema>): Schema {
	return {
		summary,
		description,
		tags,
		...(requestBody ? { requestBody } : {}),
		responses: responses ?? { 200: response({ type: "object" }) },
	};
}

function authErrorResponses(): Record<string, Schema> {
	return {
		400: response(objectSchema({ error: { type: "string" } }, ["error"], "ErrorResponse"), "Bad request"),
		401: response(objectSchema({ error: { type: "string" } }, ["error"], "ErrorResponse"), "Unauthorized"),
		403: response(objectSchema({ error: { type: "string" } }, ["error"], "ErrorResponse"), "Forbidden"),
	};
}

function commonErrorResponses(): Record<string, Schema> {
	return {
		400: response(objectSchema({ error: { type: "string" } }, ["error"], "ErrorResponse"), "Bad request"),
		404: response(objectSchema({ error: { type: "string" } }, ["error"], "ErrorResponse"), "Not found"),
		500: response(objectSchema({ error: { type: "string" } }, ["error"], "ErrorResponse"), "Server error"),
	};
}

function userSchema(): Schema {
	return objectSchema(
		{
			id: { type: "string" },
			email: { type: "string" },
			name: { type: "string" },
			tenantId: { type: "string" },
			role: { type: "string", enum: ["user", "admin"] },
			readRoots: arraySchema({ type: "string" }),
			writeRoots: arraySchema({ type: "string" }),
			createdAt: { type: "number" },
			updatedAt: { type: "number" },
		},
		["id", "email", "name", "tenantId", "role", "readRoots", "writeRoots", "createdAt", "updatedAt"],
		"AuthUser"
	);
}

function tokenRecordSchema(): Schema {
	return objectSchema(
		{
			token_id: { type: "string" },
			tenant_id: { type: "string" },
			token_name: { type: "string" },
			subject: { type: "string" },
			description: { type: "string" },
			avatar_url: { type: "string" },
			avatar_alt: { type: "string" },
			avatar_background: { type: "string" },
			scopes: arraySchema({ type: "string" }),
			read_roots: arraySchema({ type: "string" }),
			write_roots: arraySchema({ type: "string" }),
			locked_paths: arraySchema({ type: "string" }),
			created_at: { type: "number" },
			updated_at: { type: "number" },
			expires_at: { type: "number" },
		},
		["token_id", "tenant_id", "token_name", "subject", "description", "avatar_url", "avatar_alt", "avatar_background", "scopes", "read_roots", "write_roots", "locked_paths", "created_at", "updated_at", "expires_at"],
		"TokenLockRecord"
	);
}

function fileNodeSchema(): Schema {
	return objectSchema(
		{
			name: { type: "string" },
			relativePath: { type: "string" },
			kind: { type: "string", enum: ["file", "folder"] },
			locked: { type: "boolean" },
			fileId: { anyOf: [{ type: "string" }, { type: "null" }] },
			folderId: { anyOf: [{ type: "string" }, { type: "null" }] },
			file_id: { anyOf: [{ type: "string" }, { type: "null" }] },
			folder_id: { anyOf: [{ type: "string" }, { type: "null" }] },
			sizeBytes: { anyOf: [{ type: "number" }, { type: "null" }] },
			createdAt: { anyOf: [{ type: "number" }, { type: "null" }] },
			modifiedAt: { anyOf: [{ type: "number" }, { type: "null" }] },
			children: { anyOf: [arraySchema({ $ref: "#/components/schemas/FileNode" }), { type: "null" }] },
		},
		["name", "relativePath", "kind", "locked"],
		"FileNode"
	);
}

function fileMetadataSchema(): Schema {
	return objectSchema(
		{
			relative_path: { type: "string" },
			file_location: { type: "string" },
			kind: { type: "string", enum: ["file", "folder"] },
			exists: { type: "boolean" },
			locked: { type: "boolean" },
			size_bytes: { anyOf: [{ type: "number" }, { type: "null" }] },
			created_at: { type: "number" },
			modified_at: { type: "number" },
			file_id: { anyOf: [{ type: "string" }, { type: "null" }] },
			folder_id: { anyOf: [{ type: "string" }, { type: "null" }] },
			content: { anyOf: [{ type: "string" }, { type: "null" }] },
		},
		["relative_path", "file_location", "kind", "exists", "locked", "created_at", "modified_at", "content"],
		"FileMetadata"
	);
}

function listItemSchema(): Schema {
	return objectSchema(
		{
			name: { type: "string" },
			relativePath: { type: "string" },
			kind: { type: "string", enum: ["file", "folder"] },
			locked: { type: "boolean" },
			fileId: { anyOf: [{ type: "string" }, { type: "null" }] },
			folderId: { anyOf: [{ type: "string" }, { type: "null" }] },
			file_id: { anyOf: [{ type: "string" }, { type: "null" }] },
			folder_id: { anyOf: [{ type: "string" }, { type: "null" }] },
			sizeBytes: { anyOf: [{ type: "number" }, { type: "null" }] },
			modifiedAt: { anyOf: [{ type: "number" }, { type: "null" }] },
		},
		["name", "relativePath", "kind", "locked"],
		"ListItem"
	);
}

function openApiBase(): Schema {
	return {
		openapi: "3.1.0",
		info: {
			title: API_TITLE,
			version: API_VERSION,
			description: API_DESCRIPTION,
		},
		servers: [
			{ url: "/api", description: "Compatibility surface" },
			{ url: `/api/${API_VERSION}`, description: "Versioned surface" },
		],
		tags: [
			{ name: "System" },
			{ name: "Auth" },
			{ name: "Vault" },
			{ name: "Tokens" },
			{ name: "Users" },
			{ name: "Search" },
			{ name: "Embedding" },
		],
		components: {
			schemas: {
				ErrorResponse: objectSchema({ error: { type: "string" } }, ["error"], "ErrorResponse"),
				HealthResponse: objectSchema(
					{
						status: { type: "string" },
						api_version: { type: "string" },
						services: {
							type: "object",
							additionalProperties: true,
						},
					},
					["status", "api_version", "services"],
					"HealthResponse"
				),
				SessionUser: userSchema(),
				RegisterRequest: objectSchema(
					{
						email: { type: "string" },
						password: { type: "string" },
						name: { type: "string" },
						role: { type: "string", enum: ["user", "admin"] },
					},
					["email", "password"],
					"RegisterRequest"
				),
				LoginRequest: objectSchema(
					{
						email: { type: "string" },
						password: { type: "string" },
					},
					["email", "password"],
					"LoginRequest"
				),
				RegisterResponse: objectSchema({ user: { $ref: "#/components/schemas/SessionUser" } }, ["user"], "RegisterResponse"),
				LoginResponse: objectSchema({ user: { $ref: "#/components/schemas/SessionUser" } }, ["user"], "LoginResponse"),
				MeResponse: objectSchema({ user: { $ref: "#/components/schemas/SessionUser" } }, ["user"], "MeResponse"),
				LogoutResponse: objectSchema({ logged_out: { type: "boolean" } }, ["logged_out"], "LogoutResponse"),
				EmbedRequest: objectSchema(
					{
						text: { type: "string" },
						texts: arraySchema({ type: "string" }),
						include_metadata: { type: "boolean" },
					},
					[],
					"EmbedRequest"
				),
				EmbedResponse: objectSchema(
					{
						vectors: arraySchema(arraySchema({ type: "number" })),
						model_name: { type: "string" },
						dimension: { type: "number" },
						metadata: { type: "object", additionalProperties: true },
					},
					["vectors", "model_name", "dimension"],
					"EmbedResponse"
				),
				SearchRequest: objectSchema(
					{
						query: { type: "string" },
						top_k: { type: "number" },
						topK: { type: "number" },
					},
					["query"],
					"SearchRequest"
				),
				SearchResult: objectSchema(
					{
						file_id: { type: "string" },
						relative_path: { type: "string" },
						score: { type: "number" },
						chunk_index: { type: "number" },
						embedding_model: { type: "string" },
					},
					["relative_path", "score"],
					"SearchResult"
				),
				SearchResponse: objectSchema(
					{
						tenant_id: { type: "string" },
						query: { type: "string" },
						top_k: { type: "number" },
						matches: arraySchema({ $ref: "#/components/schemas/SearchResult" }),
					},
					["tenant_id", "query", "top_k", "matches"],
					"SearchResponse"
				),
				FileCreateRequest: objectSchema(
					{
						kind: { type: "string", enum: ["file", "folder"] },
						path: { type: "string" },
						content: { type: "string" },
						embedding_model: { type: "string" },
					},
					["path"],
					"FileCreateRequest"
				),
				FileCreateResponse: objectSchema(
					{
						created: { type: "boolean" },
						kind: { type: "string", enum: ["file", "folder"] },
						path: { type: "string" },
						file_id: { anyOf: [{ type: "string" }, { type: "null" }] },
						folder_id: { anyOf: [{ type: "string" }, { type: "null" }] },
						content: { anyOf: [{ type: "string" }, { type: "null" }] },
					},
					["created", "kind", "path"],
					"FileCreateResponse"
				),
				FileUpdateRequest: objectSchema(
					{
						path: { type: "string" },
						content: { type: "string" },
						append: { type: "boolean" },
						embedding_model: { type: "string" },
					},
					[],
					"FileUpdateRequest"
				),
				FileUpdateResponse: objectSchema(
					{
						updated: { type: "boolean" },
						file_id: { anyOf: [{ type: "string" }, { type: "null" }] },
						folder_id: { anyOf: [{ type: "string" }, { type: "null" }] },
						path: { type: "string" },
						metadata: { $ref: "#/components/schemas/FileMetadata" },
						content: { anyOf: [{ type: "string" }, { type: "null" }] },
					},
					["updated", "file_id", "path", "metadata"],
					"FileUpdateResponse"
				),
				FileDeleteResponse: objectSchema(
					{
						deleted: { type: "boolean" },
						file_id: { anyOf: [{ type: "string" }, { type: "null" }] },
						folder_id: { anyOf: [{ type: "string" }, { type: "null" }] },
						path: { type: "string" },
					},
					["deleted", "file_id", "path"],
					"FileDeleteResponse"
				),
				FileMetadata: fileMetadataSchema(),
				FileNode: fileNodeSchema(),
				FileListItem: listItemSchema(),
				FileListResponse: objectSchema(
					{
						tenant_id: { type: "string" },
						path: { type: "string" },
						view: { type: "string", enum: ["tree", "list"] },
						locked_paths: arraySchema({ type: "string" }),
						usage_bytes: { type: "number" },
						max_bytes: { type: "number" },
						data: {
							oneOf: [{ $ref: "#/components/schemas/FileNode" }, arraySchema({ $ref: "#/components/schemas/FileListItem" })],
						},
					},
					["tenant_id", "path", "view", "locked_paths", "usage_bytes", "max_bytes", "data"],
					"FileListResponse"
				),
				VaultUsageResponse: objectSchema(
					{
						api_version: { type: "string" },
						tenant_id: { type: "string" },
						path: { type: "string" },
						view: { type: "string", enum: ["tree", "list"] },
						usage_bytes: { type: "number" },
						max_bytes: { type: "number" },
					},
					["api_version", "tenant_id", "path", "view", "usage_bytes", "max_bytes"],
					"VaultUsageResponse"
				),
				VaultLocksResponse: objectSchema(
					{
						tenant_id: { type: "string" },
						scope_path: { type: "string" },
						count: { type: "number" },
						locked_paths: arraySchema({ type: "string" }),
					},
					["tenant_id", "scope_path", "count", "locked_paths"],
					"VaultLocksResponse"
				),
				TokenCreateRequest: objectSchema(
					{
						tokenName: { type: "string" },
						token_name: { type: "string" },
						subject: { type: "string" },
						scopes: arraySchema({ type: "string" }),
						readRoots: arraySchema({ type: "string" }),
						writeRoots: arraySchema({ type: "string" }),
						read_roots: arraySchema({ type: "string" }),
						write_roots: arraySchema({ type: "string" }),
						ttlDays: { type: "number" },
						ttl_days: { type: "number" },
						issuer: { type: "string" },
						audience: { type: "string" },
						providerName: { type: "string" },
						provider_name: { type: "string" },
						description: { type: "string" },
						avatarUrl: { type: "string" },
						avatar_url: { type: "string" },
						avatarAlt: { type: "string" },
						avatar_alt: { type: "string" },
						avatarBackground: { type: "string" },
						avatar_background: { type: "string" },
					},
					["subject"],
					"TokenCreateRequest"
				),
				TokenUpdateRequest: objectSchema(
					{
						tokenName: { type: "string" },
						token_name: { type: "string" },
						providerName: { type: "string" },
						provider_name: { type: "string" },
						description: { type: "string" },
						avatarUrl: { type: "string" },
						avatar_url: { type: "string" },
						avatarAlt: { type: "string" },
						avatar_alt: { type: "string" },
						avatarBackground: { type: "string" },
						avatar_background: { type: "string" },
						revoked: { type: "boolean" },
					},
					[],
					"TokenUpdateRequest"
				),
				TokenCreateResponse: objectSchema(
					{
						api_version: { type: "string" },
						tenant_id: { type: "string" },
						token_id: { type: "string" },
						token_name: { type: "string" },
						token: { type: "string" },
					},
					["api_version", "tenant_id", "token_id", "token_name", "token"],
					"TokenCreateResponse"
				),
				TokenListResponse: objectSchema(
					{
						api_version: { type: "string" },
						tenant_id: { type: "string" },
						count: { type: "number" },
						tokens: arraySchema({ $ref: "#/components/schemas/TokenRecord" }),
					},
					["api_version", "tenant_id", "count", "tokens"],
					"TokenListResponse"
				),
				TokenRecord: tokenRecordSchema(),
				TokenDetailResponse: objectSchema(
					{
						api_version: { type: "string" },
						tenant_id: { type: "string" },
						token: { $ref: "#/components/schemas/TokenRecord" },
					},
					["api_version", "tenant_id", "token"],
					"TokenDetailResponse"
				),
				TokenDeleteResponse: objectSchema(
					{
						api_version: { type: "string" },
						tenant_id: { type: "string" },
						deleted: { type: "boolean" },
						token_id: { type: "string" },
					},
					["api_version", "tenant_id", "deleted", "token_id"],
					"TokenDeleteResponse"
				),
				UserListResponse: objectSchema(
					{
						api_version: { type: "string" },
						users: arraySchema({ $ref: "#/components/schemas/SessionUser" }),
					},
					["api_version", "users"],
					"UserListResponse"
				),
				UserCreateResponse: objectSchema(
					{
						api_version: { type: "string" },
						user: { $ref: "#/components/schemas/SessionUser" },
					},
					["api_version", "user"],
					"UserCreateResponse"
				),
				VaultReindexRequest: objectSchema(
					{
						path: { type: "string" },
						embedding_model: { type: "string" },
						embeddingModel: { type: "string" },
					},
					[],
					"VaultReindexRequest"
				),
				VaultReindexResponse: objectSchema(
					{
						api_version: { type: "string" },
						tenant_id: { type: "string" },
						path: { type: "string" },
						count: { type: "number" },
						skipped: { type: "number" },
						results: arraySchema(
							objectSchema(
								{
									path: { type: "string" },
									file_id: { type: "string" },
									updated_chunks: { type: "number" },
								},
								["path", "file_id", "updated_chunks"],
								"ReindexResult"
							)
						),
					},
					["api_version", "tenant_id", "path", "count", "skipped", "results"],
					"VaultReindexResponse"
				),
				OpenApiDocument: { type: "object" },
			},
			securitySchemes: {
				sessionCookie: { type: "apiKey", in: "cookie", name: "brain_session" },
				bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
			},
		},
	};
}

function routeDocs(): Record<string, Schema> {
	return {
		"/api": {
			get: pathItem(
				"API index",
				"Return the current API version and the top-level route list.",
				["System"],
				undefined,
				{
					200: response(
						objectSchema(
							{
								name: { type: "string" },
								api_version: { type: "string" },
								versioned_root: { type: "string" },
								routes: arraySchema({ type: "string" }),
							},
							["name", "api_version", "versioned_root", "routes"],
							"ApiIndexResponse"
						)
					),
				}
			),
		},
		"/health": {
			get: pathItem(
				"Health check",
				"Check backend and dependency health status.",
				["System"],
				undefined,
				{ 200: response({ $ref: "#/components/schemas/HealthResponse" }) }
			),
		},
		"/openapi": {
			get: pathItem(
				"OpenAPI document",
				"Return the generated OpenAPI 3.1 document for the backend API.",
				["System"],
				undefined,
				{
					200: response({ $ref: "#/components/schemas/OpenApiDocument" }),
				}
			),
		},
		"/auth/register": {
			post: pathItem("Register user", "Create a local auth user and return a session cookie.", ["Auth"], { content: { "application/json": { schema: { $ref: "#/components/schemas/RegisterRequest" } } } }, {
				200: response({ $ref: "#/components/schemas/RegisterResponse" }),
				...authErrorResponses(),
			}),
		},
		"/auth/login": {
			post: pathItem("Login user", "Authenticate a local auth user and return a session cookie.", ["Auth"], { content: { "application/json": { schema: { $ref: "#/components/schemas/LoginRequest" } } } }, {
				200: response({ $ref: "#/components/schemas/LoginResponse" }),
				...authErrorResponses(),
			}),
		},
		"/auth/logout": {
			post: pathItem(
				"Logout user",
				"Clear the current session cookie.",
				["Auth"],
				undefined,
				{ 200: response({ $ref: "#/components/schemas/LogoutResponse" }) }
			),
		},
		"/auth/me": {
			get: pathItem(
				"Current session",
				"Return the current authenticated session claims.",
				["Auth"],
				undefined,
				{ 200: response({ $ref: "#/components/schemas/MeResponse" }) }
			),
		},
		"/embed": {
			get: pathItem(
				"Embedding info",
				"Describe the embedding endpoint request format.",
				["Embedding"],
				undefined,
				{ 200: response(objectSchema({ route: { type: "string" }, method: { type: "string" }, auth: { type: "string" }, body: { type: "object" } }, ["route", "method", "auth", "body"], "EmbedInfo")) }
			),
			post: pathItem("Embed text", "Embed one or more texts and return vectors.", ["Embedding"], { content: { "application/json": { schema: { $ref: "#/components/schemas/EmbedRequest" } } } }, {
				200: response({ $ref: "#/components/schemas/EmbedResponse" }),
				...authErrorResponses(),
			}),
		},
		"/search": {
			get: pathItem(
				"Search info",
				"Describe the search endpoint request format.",
				["Search"],
				undefined,
				{ 200: response(objectSchema({ route: { type: "string" }, method: { type: "string" }, auth: { type: "string" }, body: { type: "object" } }, ["route", "method", "auth", "body"], "SearchInfo")) }
			),
			post: pathItem("Search vault", "Run a semantic search against the tenant vault.", ["Search"], { content: { "application/json": { schema: { $ref: "#/components/schemas/SearchRequest" } } } }, {
				200: response({ $ref: "#/components/schemas/SearchResponse" }),
				...authErrorResponses(),
			}),
		},
		"/files": {
			get: pathItem(
				"Browse vault",
				"Return a tree or flat listing for a vault path.",
				["Vault"],
				undefined,
				{
					200: response({ $ref: "#/components/schemas/FileListResponse" }),
				}
			),
			post: pathItem("Create file or folder", "Create a file or folder and index content if needed.", ["Vault"], { content: { "application/json": { schema: { $ref: "#/components/schemas/FileCreateRequest" } } } }, {
				200: response({ $ref: "#/components/schemas/FileCreateResponse" }),
				...authErrorResponses(),
			}),
		},
		"/files/{id}": {
			get: pathItem("Read file", "Fetch a file or folder by stable file_id or folder_id.", ["Vault"], undefined, { 200: response({ $ref: "#/components/schemas/FileMetadata" }) }),
			put: pathItem("Update file", "Move or edit a file or folder by stable file_id or folder_id.", ["Vault"], { content: { "application/json": { schema: { $ref: "#/components/schemas/FileUpdateRequest" } } } }, {
				200: response({ $ref: "#/components/schemas/FileUpdateResponse" }),
				...authErrorResponses(),
			}),
			delete: pathItem("Delete file", "Delete a file or folder by stable file_id or folder_id.", ["Vault"], undefined, {
				200: response({ $ref: "#/components/schemas/FileDeleteResponse" }),
				...authErrorResponses(),
			}),
		},
		"/vault/locks": {
			get: pathItem("List vault locks", "List lock entries visible to the current session.", ["Vault"], undefined, {
				200: response({ $ref: "#/components/schemas/VaultLocksResponse" }),
			}),
			post: pathItem("Lock paths", "Lock one or more vault paths.", ["Vault"], { content: { "application/json": { schema: objectSchema({ path: { type: "string" }, paths: arraySchema({ type: "string" }), file_id: { type: "string" }, file_ids: arraySchema({ type: "string" }), folder_id: { type: "string" }, folder_ids: arraySchema({ type: "string" }) }, [], "LockPathsRequest") } } }, {
				200: response({ $ref: "#/components/schemas/VaultLocksResponse" }),
				...authErrorResponses(),
			}),
			delete: pathItem("Unlock paths", "Unlock one or more vault paths.", ["Vault"], { content: { "application/json": { schema: objectSchema({ path: { type: "string" }, paths: arraySchema({ type: "string" }), file_id: { type: "string" }, file_ids: arraySchema({ type: "string" }), folder_id: { type: "string" }, folder_ids: arraySchema({ type: "string" }) }, [], "UnlockPathsRequest") } } }, {
				200: response({ $ref: "#/components/schemas/VaultLocksResponse" }),
				...authErrorResponses(),
			}),
		},
		"/vault/usage": {
			get: pathItem("Vault usage", "Return vault usage and size limits.", ["Vault"], undefined, {
				200: response({ $ref: "#/components/schemas/VaultUsageResponse" }),
			}),
		},
		"/vault/reindex": {
			post: pathItem("Reindex vault", "Rebuild embeddings for the selected vault subtree.", ["Vault"], { content: { "application/json": { schema: { $ref: "#/components/schemas/VaultReindexRequest" } } } }, {
				200: response({ $ref: "#/components/schemas/VaultReindexResponse" }),
				...authErrorResponses(),
			}),
		},
		"/tokens": {
			get: pathItem("List tokens", "List MCP tokens for the current tenant.", ["Tokens"], undefined, {
				200: response({ $ref: "#/components/schemas/TokenListResponse" }),
			}),
			post: pathItem("Create token", "Issue a new MCP token for the current tenant.", ["Tokens"], { content: { "application/json": { schema: { $ref: "#/components/schemas/TokenCreateRequest" } } } }, {
				200: response({ $ref: "#/components/schemas/TokenCreateResponse" }),
				...authErrorResponses(),
			}),
		},
		"/tokens/{tokenId}": {
			get: pathItem("Get token", "Fetch one MCP token record for the current tenant.", ["Tokens"], undefined, {
				200: response({ $ref: "#/components/schemas/TokenDetailResponse" }),
				...authErrorResponses(),
			}),
			patch: pathItem("Update token", "Update token metadata and visual identity fields.", ["Tokens"], { content: { "application/json": { schema: { $ref: "#/components/schemas/TokenUpdateRequest" } } } }, {
				200: response({ $ref: "#/components/schemas/TokenDetailResponse" }),
				...authErrorResponses(),
			}),
			delete: pathItem("Delete token", "Revoke and remove a token record for the current tenant.", ["Tokens"], undefined, {
				200: response({ $ref: "#/components/schemas/TokenDeleteResponse" }),
				...authErrorResponses(),
			}),
		},
		"/mcp/token": {
			post: pathItem("Create MCP token", "Issue a token through the MCP token route.", ["Tokens"], { content: { "application/json": { schema: { $ref: "#/components/schemas/TokenCreateRequest" } } } }, {
				200: response({ $ref: "#/components/schemas/TokenCreateResponse" }),
				...authErrorResponses(),
			}),
		},
		"/mcp/token/{tokenId}/locks": {
			get: pathItem("Get token locks", "Read mutable lock state for a specific MCP token.", ["Tokens"], undefined, {
				200: response(objectSchema({ token_id: { type: "string" }, tenant_id: { type: "string" }, token_name: { type: "string" }, subject: { type: "string" }, scopes: arraySchema({ type: "string" }), scope_path: { type: "string" }, count: { type: "number" }, locked_paths: arraySchema({ type: "string" }) }, ["token_id", "tenant_id", "token_name", "subject", "scopes", "scope_path", "count", "locked_paths"], "TokenLocksResponse")),
			}),
			post: pathItem("Lock token paths", "Add mutable locks to a specific MCP token.", ["Tokens"], { content: { "application/json": { schema: objectSchema({ path: { type: "string" }, paths: arraySchema({ type: "string" }), file_id: { type: "string" }, file_ids: arraySchema({ type: "string" }), folder_id: { type: "string" }, folder_ids: arraySchema({ type: "string" }) }, [], "TokenLockPathsRequest") } } }, {
				200: response(objectSchema({ token_id: { type: "string" }, tenant_id: { type: "string" }, action: { type: "string" }, count: { type: "number" }, changed: { type: "number" }, results: arraySchema(objectSchema({ path: { type: "string" }, locked: { type: "boolean" }, changed: { type: "boolean" } }, ["path", "locked", "changed"], "TokenLockMutationResult")), locked_paths: arraySchema({ type: "string" }) }, ["token_id", "tenant_id", "action", "count", "changed", "results", "locked_paths"], "TokenLockMutationResponse")),
				...authErrorResponses(),
			}),
			delete: pathItem("Unlock token paths", "Remove mutable locks from a specific MCP token.", ["Tokens"], { content: { "application/json": { schema: objectSchema({ path: { type: "string" }, paths: arraySchema({ type: "string" }), file_id: { type: "string" }, file_ids: arraySchema({ type: "string" }), folder_id: { type: "string" }, folder_ids: arraySchema({ type: "string" }) }, [], "TokenUnlockPathsRequest") } } }, {
				200: response(objectSchema({ token_id: { type: "string" }, tenant_id: { type: "string" }, action: { type: "string" }, count: { type: "number" }, changed: { type: "number" }, results: arraySchema(objectSchema({ path: { type: "string" }, locked: { type: "boolean" }, changed: { type: "boolean" } }, ["path", "locked", "changed"], "TokenUnlockMutationResult")), locked_paths: arraySchema({ type: "string" }) }, ["token_id", "tenant_id", "action", "count", "changed", "results", "locked_paths"], "TokenUnlockMutationResponse")),
				...authErrorResponses(),
			}),
		},
		"/users": {
			get: pathItem("List users", "List local auth users. Admin only.", ["Users"], undefined, {
				200: response({ $ref: "#/components/schemas/UserListResponse" }),
				...authErrorResponses(),
			}),
			post: pathItem("Create user", "Create a local auth user. Admin only.", ["Users"], { content: { "application/json": { schema: { $ref: "#/components/schemas/RegisterRequest" } } } }, {
				200: response({ $ref: "#/components/schemas/UserCreateResponse" }),
				...authErrorResponses(),
			}),
		},
	};
}

export function buildOpenApiSpec(): Record<string, unknown> {
	const base = openApiBase();
	return {
		...base,
		paths: routeDocs(),
		components: {
			...(base.components as Record<string, unknown>),
			securitySchemes: (base.components as Record<string, unknown>).securitySchemes,
		},
	};
}
