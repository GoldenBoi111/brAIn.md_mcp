import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { issueToken, verifyToken } from "./backend";
import { BackendError } from "./errors";
import type { AuthSessionClaims } from "./user_auth";

export type OAuthRegisteredClient = {
  client_id: string;
  client_secret: string | null;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "client_secret_basic" | "client_secret_post" | "none";
  grant_types: string[];
  response_types: string[];
  created_at: number;
};

type OAuthAuthorizationCode = {
  client_id: string;
  redirect_uri: string;
  scope: string[];
  state: string | null;
  code_challenge: string | null;
  code_challenge_method: "S256" | "plain" | null;
  token_name: string;
  provider_name: string;
  description: string;
  avatar_url: string;
  avatar_alt: string;
  avatar_background: string;
  session: AuthSessionClaims;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
};

type OAuthStore = {
  clients: OAuthRegisteredClient[];
  codes: Record<string, OAuthAuthorizationCode>;
  updated_at: number;
};

export type OAuthAuthorizeRequest = {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  scope: string[];
  state: string | null;
  code_challenge: string | null;
  code_challenge_method: "S256" | "plain" | null;
  token_name: string;
  provider_name: string;
  description: string;
  avatar_url: string;
  avatar_alt: string;
  avatar_background: string;
};

export type OAuthTokenRequest = {
  client_id: string;
  client_secret: string | null;
  grant_type: string;
  code: string;
  redirect_uri: string;
  code_verifier: string | null;
};

export type OAuthTokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  tenant_id: string;
  token_id: string;
  token_name: string;
  provider_name: string;
};

const DEFAULT_CODE_TTL_SECONDS = Number(process.env.CLAUDE_OAUTH_CODE_TTL_SECONDS ?? "600");
const DEFAULT_CLIENT_SECRET = process.env.CLAUDE_OAUTH_CLIENT_SECRET ?? "";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function storePath(): string {
  return process.env.CLAUDE_OAUTH_STORE_PATH ?? path.join(process.cwd(), ".auth", "claude-oauth.json");
}

function randomSecret(length = 32): string {
  return randomBytes(length).toString("base64url");
}

function defaultClientSecret(): string {
  return DEFAULT_CLIENT_SECRET || "brain-md-claude-secret";
}

function defaultAuthMethod(): OAuthRegisteredClient["token_endpoint_auth_method"] {
  const value = process.env.CLAUDE_OAUTH_TOKEN_ENDPOINT_AUTH_METHOD;
  if (value === "none") return "none";
  if (value === "client_secret_post") return "client_secret_post";
  return "client_secret_basic";
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, "base64"));
}

function sign(secret: string, payload: Uint8Array): Uint8Array {
  return createHash("sha256").update(secret).update(payload).digest();
}

async function readStore(): Promise<OAuthStore> {
  try {
    const raw = await fs.readFile(storePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<OAuthStore>;
    return {
      clients: Array.isArray(parsed.clients) ? parsed.clients as OAuthRegisteredClient[] : [],
      codes: parsed.codes && typeof parsed.codes === "object" ? parsed.codes as Record<string, OAuthAuthorizationCode> : {},
      updated_at: Number(parsed.updated_at ?? nowSeconds()),
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return { clients: [], codes: {}, updated_at: nowSeconds() };
    }
    throw error;
  }
}

async function writeStore(store: OAuthStore): Promise<void> {
  await fs.mkdir(path.dirname(storePath()), { recursive: true });
  const tmp = `${storePath()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  await fs.rename(tmp, storePath());
}

function normalizeScopes(scopes: string[]): string[] {
  const filtered = Array.from(new Set(scopes.map((scope) => scope.trim()).filter(Boolean)));
  if (!filtered.length) {
    return ["mcp"];
  }
  const allowed = new Set(["mcp", "openid", "email", "profile"]);
  const unsupported = filtered.filter((scope) => !allowed.has(scope));
  if (unsupported.length) {
    throw new BackendError(`Unsupported scope(s): ${unsupported.join(", ")}`, 400);
  }
  if (!filtered.includes("mcp")) {
    throw new BackendError("The mcp scope is required", 400);
  }
  return filtered;
}

function validateRedirectUri(client: OAuthRegisteredClient, redirectUri: string): void {
  if (!client.redirect_uris.includes(redirectUri)) {
    throw new BackendError("redirect_uri is not registered for this client", 400);
  }
}

function validateCodeChallengeMethod(method: string | null): "S256" | "plain" | null {
  if (method === null) return null;
  if (method === "S256" || method === "plain") return method;
  throw new BackendError("Unsupported code_challenge_method", 400);
}

function verifyPkce(codeChallenge: string | null, method: "S256" | "plain" | null, verifier: string | null): void {
  if (!codeChallenge) return;
  if (!verifier) {
    throw new BackendError("Missing code_verifier", 400);
  }
  if (method === "plain") {
    if (verifier !== codeChallenge) {
      throw new BackendError("Invalid code_verifier", 400);
    }
    return;
  }
  const digest = createHash("sha256").update(verifier).digest();
  const expected = base64UrlEncode(digest);
  if (expected !== codeChallenge) {
    throw new BackendError("Invalid code_verifier", 400);
  }
}

function verifyClientSecret(client: OAuthRegisteredClient, clientSecret: string | null): void {
  if (client.token_endpoint_auth_method === "none") return;
  const expected = client.client_secret ?? defaultClientSecret();
  if (!clientSecret || clientSecret !== expected) {
    throw new BackendError("Invalid client credentials", 401);
  }
}

export async function registerOAuthClient(input: {
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method?: OAuthRegisteredClient["token_endpoint_auth_method"];
}): Promise<OAuthRegisteredClient> {
  if (!Array.isArray(input.redirect_uris) || !input.redirect_uris.length) {
    throw new BackendError("redirect_uris is required", 400);
  }
  const client: OAuthRegisteredClient = {
    client_id: randomUUID(),
    client_secret: (input.token_endpoint_auth_method ?? defaultAuthMethod()) === "none" ? null : randomSecret(),
    client_name: String(input.client_name ?? "brAIn.md Claude bridge").trim() || "brAIn.md Claude bridge",
    redirect_uris: input.redirect_uris.map((uri) => String(uri).trim()).filter(Boolean),
    token_endpoint_auth_method: input.token_endpoint_auth_method ?? defaultAuthMethod(),
    grant_types: ["authorization_code"],
    response_types: ["code"],
    created_at: nowSeconds(),
  };
  const store = await readStore();
  store.clients.push(client);
  store.updated_at = nowSeconds();
  await writeStore(store);
  return client;
}

export async function getOAuthClient(clientId: string): Promise<OAuthRegisteredClient | null> {
  const store = await readStore();
  return store.clients.find((client) => client.client_id === clientId) ?? null;
}

export function normalizeOAuthScope(scope: string | null | undefined): string[] {
  if (!scope) return ["mcp"];
  return normalizeScopes(scope.split(/\s+/g));
}

function normalizeOptionalName(value: string | null | undefined, fallback: string): string {
  const trimmed = String(value ?? "").trim();
  return trimmed || fallback;
}

function normalizeOptionalText(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function createAuthorizationCode(input: OAuthAuthorizeRequest & { session: AuthSessionClaims }): Promise<string> {
  const client = await getOAuthClient(input.client_id);
  if (!client) {
    throw new BackendError("Unknown OAuth client", 400);
  }
  if (input.response_type !== "code") {
    throw new BackendError("Only response_type=code is supported", 400);
  }
  validateRedirectUri(client, input.redirect_uri);

  const code = randomSecret(48);
  const store = await readStore();
  store.codes[code] = {
    client_id: client.client_id,
    redirect_uri: input.redirect_uri,
    scope: normalizeScopes(input.scope),
    state: input.state,
    code_challenge: input.code_challenge,
    code_challenge_method: validateCodeChallengeMethod(input.code_challenge_method),
    token_name: normalizeOptionalName(input.token_name, "claude-web"),
    provider_name: normalizeOptionalName(input.provider_name, client.client_name),
    description: normalizeOptionalText(input.description),
    avatar_url: normalizeOptionalText(input.avatar_url),
    avatar_alt: normalizeOptionalText(input.avatar_alt),
    avatar_background: normalizeOptionalText(input.avatar_background),
    session: input.session,
    created_at: nowSeconds(),
    expires_at: nowSeconds() + DEFAULT_CODE_TTL_SECONDS,
    consumed_at: null,
  };
  store.updated_at = nowSeconds();
  await writeStore(store);
  return code;
}

export function parseBasicAuth(header: string | null): { client_id: string; client_secret: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const index = decoded.indexOf(":");
  if (index < 0) return null;
  return {
    client_id: decoded.slice(0, index),
    client_secret: decoded.slice(index + 1),
  };
}

export function parseTokenRequestBody(body: Record<string, unknown>): OAuthTokenRequest {
  const grant_type = String(body.grant_type ?? "").trim();
  const code = String(body.code ?? "").trim();
  const redirect_uri = String(body.redirect_uri ?? "").trim();
  if (!grant_type) throw new BackendError("Missing grant_type", 400);
  if (!code) throw new BackendError("Missing code", 400);
  if (!redirect_uri) throw new BackendError("Missing redirect_uri", 400);
  return {
    client_id: String(body.client_id ?? "").trim(),
    client_secret: typeof body.client_secret === "string" ? body.client_secret : null,
    grant_type,
    code,
    redirect_uri,
    code_verifier: typeof body.code_verifier === "string" ? body.code_verifier.trim() || null : null,
  };
}

export async function consumeAuthorizationCode(input: OAuthTokenRequest): Promise<{ session: AuthSessionClaims; scope: string[]; tokenName: string; providerName: string; description: string; avatarUrl: string; avatarAlt: string; avatarBackground: string; clientId: string; clientName: string }> {
  if (input.grant_type !== "authorization_code") {
    throw new BackendError("Only authorization_code grant_type is supported", 400);
  }
  const client = await getOAuthClient(input.client_id);
  if (!client) {
    throw new BackendError("Unknown OAuth client", 400);
  }
  validateRedirectUri(client, input.redirect_uri);
  verifyClientSecret(client, input.client_secret);

  const store = await readStore();
  const record = store.codes[input.code];
  if (!record) {
    throw new BackendError("Unknown authorization code", 400);
  }
  if (record.consumed_at) {
    throw new BackendError("Authorization code already used", 400);
  }
  if (record.expires_at <= nowSeconds()) {
    throw new BackendError("Authorization code expired", 400);
  }
  if (record.client_id !== client.client_id || record.redirect_uri !== input.redirect_uri) {
    throw new BackendError("Authorization code does not match client or redirect_uri", 400);
  }
  verifyPkce(record.code_challenge, record.code_challenge_method, input.code_verifier);

  record.consumed_at = nowSeconds();
  store.codes[input.code] = record;
  store.updated_at = nowSeconds();
  await writeStore(store);
  return {
    session: record.session,
    scope: record.scope,
    tokenName: record.token_name,
    providerName: record.provider_name,
    clientId: record.client_id,
    clientName: client.client_name,
    description: record.description,
    avatarUrl: record.avatar_url,
    avatarAlt: record.avatar_alt,
    avatarBackground: record.avatar_background,
  };
}

export async function mintOAuthAccessToken(input: { session: AuthSessionClaims; scope: string[]; tokenName?: string; providerName?: string; description?: string; avatarUrl?: string; avatarAlt?: string; avatarBackground?: string; oauthClientId?: string; oauthClientName?: string }): Promise<OAuthTokenResponse> {
  const token = await issueToken({
    tenantId: input.session.tenantId,
    tokenName: normalizeOptionalName(input.tokenName, "claude-web"),
    subject: input.session.userId,
    email: input.session.email,
    scopes: normalizeScopes(input.scope),
    readRoots: input.session.readRoots,
    writeRoots: input.session.writeRoots,
    ttlDays: Number(process.env.CLAUDE_OAUTH_ACCESS_TTL_DAYS ?? "365"),
    source: "oauth",
    providerName: input.providerName ?? "",
    createdBy: input.session.email,
    description: input.description,
    avatarUrl: input.avatarUrl,
    avatarAlt: input.avatarAlt,
    avatarBackground: input.avatarBackground,
    oauthClientId: input.oauthClientId ?? "",
    oauthClientName: input.oauthClientName ?? "",
  });
  const claims = await verifyToken(token);
  return {
    access_token: token,
    token_type: "Bearer",
    expires_in: Math.max(0, claims.expiresAt - nowSeconds()),
    scope: input.scope.join(" "),
    tenant_id: claims.tenantId,
    token_id: claims.jwtId,
    token_name: claims.tokenName,
    provider_name: normalizeOptionalName(input.providerName, "Claude"),
  };
}

export function buildAuthorizeRedirect(redirectUri: string, code: string, state: string | null): string {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) {
    url.searchParams.set("state", state);
  }
  return url.toString();
}

export function oauthAuthorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    scopes_supported: ["openid", "email", "profile", "mcp"],
    subject_types_supported: ["public"],
    claims_supported: ["sub", "email", "name", "tenant_id"],
  };
}

export function htmlAuthorizePage(input: {
  authorizeUrl: string;
  clientName: string;
  redirectUri: string;
  scope: string[];
  tokenName: string;
  providerName: string;
  description: string;
  avatarUrl: string;
  avatarAlt: string;
  avatarBackground: string;
  error?: string | null;
}): string {
  const scopes = input.scope.map((scope) => `<code>${scope}</code>`).join(", ");
  const errorBlock = input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Claude bridge login</title>
    <style>
      :root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: linear-gradient(135deg, #f4f4f2, #e8eef9); color: #111827; }
      .card { width: min(560px, calc(100vw - 32px)); background: rgba(255,255,255,0.9); border: 1px solid rgba(17,24,39,0.08); border-radius: 20px; padding: 28px; box-shadow: 0 20px 60px rgba(15,23,42,0.12); }
      h1 { margin: 0 0 12px; font-size: 28px; }
      p { line-height: 1.5; }
      .meta { background: #f8fafc; border-radius: 12px; padding: 12px 14px; margin: 16px 0; }
      .error { color: #b91c1c; font-weight: 600; }
      label { display: block; font-size: 14px; font-weight: 600; margin-top: 12px; }
      input { width: 100%; box-sizing: border-box; padding: 12px 14px; border-radius: 12px; border: 1px solid #cbd5e1; margin-top: 6px; font-size: 15px; }
      button { margin-top: 18px; width: 100%; border: 0; border-radius: 12px; padding: 12px 14px; background: #111827; color: white; font-size: 15px; font-weight: 600; cursor: pointer; }
      button:hover { background: #1f2937; }
      .small { font-size: 13px; color: #475569; }
      code { background: #e2e8f0; padding: 2px 6px; border-radius: 6px; }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>Connect Claude to brAIn.md</h1>
      <p>Sign in to approve this OAuth connection.</p>
      <div class="meta">
        <p><strong>Client:</strong> ${escapeHtml(input.clientName)}</p>
        <p><strong>Redirect:</strong> ${escapeHtml(input.redirectUri)}</p>
        <p><strong>Scope:</strong> ${scopes}</p>
      </div>
      ${errorBlock}
      <form id="login-form">
        <label for="token_name">Token name</label>
        <input id="token_name" name="token_name" type="text" autocomplete="off" value="${escapeHtml(input.tokenName)}" />
        <label for="provider_name">Provider name</label>
        <input id="provider_name" name="provider_name" type="text" autocomplete="off" value="${escapeHtml(input.providerName)}" />
        <label for="description">Description</label>
        <input id="description" name="description" type="text" autocomplete="off" value="${escapeHtml(input.description)}" />
        <label for="avatar_url">Avatar URL</label>
        <input id="avatar_url" name="avatar_url" type="url" autocomplete="off" value="${escapeHtml(input.avatarUrl)}" />
        <label for="avatar_alt">Avatar alt text</label>
        <input id="avatar_alt" name="avatar_alt" type="text" autocomplete="off" value="${escapeHtml(input.avatarAlt)}" />
        <label for="avatar_background">Avatar background</label>
        <input id="avatar_background" name="avatar_background" type="text" autocomplete="off" value="${escapeHtml(input.avatarBackground)}" />
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="email" required />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <button type="submit">Sign in and continue</button>
      </form>
      <p class="small">This page uses your existing brAIn.md session and then returns you to Claude.</p>
    </main>
    <script>
      const form = document.getElementById("login-form");
      const error = document.createElement("p");
      error.className = "error";
      form.after(error);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        error.textContent = "";
        const tokenName = document.getElementById("token_name").value.trim();
        const providerName = document.getElementById("provider_name").value.trim();
        const description = document.getElementById("description").value.trim();
        const avatarUrl = document.getElementById("avatar_url").value.trim();
        const avatarAlt = document.getElementById("avatar_alt").value.trim();
        const avatarBackground = document.getElementById("avatar_background").value.trim();
        const email = document.getElementById("email").value;
        const password = document.getElementById("password").value;
        const response = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ email, password }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          error.textContent = data.error || "Login failed";
          return;
        }
        const url = new URL(${JSON.stringify(input.authorizeUrl)});
        if (tokenName) url.searchParams.set("token_name", tokenName);
        if (providerName) url.searchParams.set("provider_name", providerName);
        if (description) url.searchParams.set("description", description);
        if (avatarUrl) url.searchParams.set("avatar_url", avatarUrl);
        if (avatarAlt) url.searchParams.set("avatar_alt", avatarAlt);
        if (avatarBackground) url.searchParams.set("avatar_background", avatarBackground);
        window.location.href = url.toString();
      });
    </script>
  </body>
</html>`;
}
