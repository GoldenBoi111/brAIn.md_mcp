import { createHmac, randomBytes, randomUUID, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { BackendError } from "./errors";

type AuthRole = "user" | "admin";

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  tenantId: string;
  role: AuthRole;
  readRoots: string[];
  writeRoots: string[];
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
};

export type AuthSessionClaims = {
  userId: string;
  email: string;
  name: string;
  tenantId: string;
  role: AuthRole;
  readRoots: string[];
  writeRoots: string[];
  issuedAt: number;
  expiresAt: number;
};

type AuthStore = {
  users: AuthUser[];
};

const SESSION_SECRET = process.env.USER_AUTH_SECRET ?? process.env.MCP_JWT_SECRET;
const SESSION_COOKIE_NAME = process.env.USER_SESSION_COOKIE ?? "brain_session";
const SESSION_TTL_SECONDS = Number(process.env.USER_SESSION_TTL_SECONDS ?? String(60 * 60 * 24 * 30));

function requireSessionSecret(): string {
  if (!SESSION_SECRET) {
    throw new BackendError("USER_AUTH_SECRET is required", 500);
  }
  return SESSION_SECRET;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, "base64"));
}

function sign(secret: string, signingInput: Uint8Array): Uint8Array {
  return createHmac("sha256", secret).update(signingInput).digest();
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function readStore(): Promise<AuthStore> {
  const authStorePath = process.env.USER_AUTH_STORE_PATH ?? "C:\\tmp\\brAIn.md MCP Server\\auth\\users.json";
  try {
    const raw = await fs.readFile(authStorePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AuthStore>;
    return { users: Array.isArray(parsed.users) ? parsed.users as AuthUser[] : [] };
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return { users: [] };
    }
    throw error;
  }
}

async function writeStore(store: AuthStore): Promise<void> {
  const authStoreDir = process.env.USER_AUTH_STORE_DIR ?? "C:\\tmp\\brAIn.md MCP Server\\auth";
  const authStorePath = process.env.USER_AUTH_STORE_PATH ?? "C:\\tmp\\brAIn.md MCP Server\\auth\\users.json";
  await fs.mkdir(authStoreDir, { recursive: true });
  const tmp = `${authStorePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  await fs.rename(tmp, authStorePath);
}

function safeUser(user: AuthUser): Omit<AuthUser, "passwordHash"> {
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}

function normalizeEmail(email: string): string {
  const value = email.trim().toLowerCase();
  if (!value || !value.includes("@")) {
    throw new BackendError("Invalid email address", 400);
  }
  return value;
}

function hashPassword(password: string): string {
  if (password.length < 8) {
    throw new BackendError("Password must be at least 8 characters", 400);
  }
  const salt = randomBytes(16).toString("hex");
  const derived = pbkdf2Sync(password, salt, 210000, 32, "sha256").toString("hex");
  return ["pbkdf2", "sha256", "210000", salt, derived].join("$");
}

function verifyPassword(password: string, hash: string): boolean {
  const parts = hash.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2") {
    return false;
  }
  const [, digest, iterationsRaw, salt, expectedHex] = parts;
  if (digest !== "sha256") {
    return false;
  }
  const iterations = Number(iterationsRaw);
  if (!Number.isFinite(iterations) || iterations <= 0) {
    return false;
  }
  const expected = Buffer.from(expectedHex, "hex");
  const actual = pbkdf2Sync(password, salt, iterations, expected.length, digest);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function canonicalJson(value: Record<string, unknown>): Uint8Array {
  return Buffer.from(JSON.stringify(value, Object.keys(value).sort()), "utf8");
}

function encodeSessionToken(claims: AuthSessionClaims): string {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: "brain-ui",
    aud: "brain-ui",
    sub: claims.userId,
    email: claims.email,
    name: claims.name,
    tenant_id: claims.tenantId,
    role: claims.role,
    read_roots: claims.readRoots,
    write_roots: claims.writeRoots,
    iat: claims.issuedAt,
    nbf: claims.issuedAt,
    exp: claims.expiresAt,
  };
  const signingInput = `${base64UrlEncode(canonicalJson(header))}.${base64UrlEncode(canonicalJson(payload))}`;
  const signature = sign(requireSessionSecret(), Buffer.from(signingInput, "ascii"));
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

export function parseCookieHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const chunk of header.split(";")) {
    const [rawKey, ...rawValueParts] = chunk.split("=");
    const key = rawKey?.trim();
    if (!key) continue;
    out[key] = decodeURIComponent(rawValueParts.join("=").trim());
  }
  return out;
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE_NAME;
}

export function getSessionTtlSeconds(): number {
  return SESSION_TTL_SECONDS;
}

export async function registerUser(input: { email: string; password: string; name?: string; role?: AuthRole }): Promise<{ user: Omit<AuthUser, "passwordHash">; sessionToken: string }> {
  const email = normalizeEmail(input.email);
  const name = (input.name ?? email.split("@")[0] ?? "user").trim() || "user";
  const store = await readStore();
  if (store.users.some((user) => user.email === email)) {
    throw new BackendError("User already exists", 409);
  }

  const now = nowSeconds();
  const user: AuthUser = {
    id: randomUUID(),
    email,
    name,
    tenantId: randomUUID(),
    role: input.role ?? (store.users.length === 0 ? "admin" : "user"),
    readRoots: ["."],
    writeRoots: ["."],
    passwordHash: hashPassword(input.password),
    createdAt: now,
    updatedAt: now,
  };
  store.users.push(user);
  await writeStore(store);

  const sessionToken = encodeSessionToken({
    userId: user.id,
    email: user.email,
    name: user.name,
    tenantId: user.tenantId,
    role: user.role,
    readRoots: user.readRoots,
    writeRoots: user.writeRoots,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_SECONDS,
  });

  return { user: safeUser(user), sessionToken };
}

export async function loginUser(input: { email: string; password: string }): Promise<{ user: Omit<AuthUser, "passwordHash">; sessionToken: string }> {
  const email = normalizeEmail(input.email);
  const store = await readStore();
  const user = store.users.find((entry) => entry.email === email);
  if (!user || !verifyPassword(input.password, user.passwordHash)) {
    throw new BackendError("Invalid email or password", 401);
  }
  const now = nowSeconds();
  const sessionToken = encodeSessionToken({
    userId: user.id,
    email: user.email,
    name: user.name,
    tenantId: user.tenantId,
    role: user.role,
    readRoots: user.readRoots,
    writeRoots: user.writeRoots,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_SECONDS,
  });
  return { user: safeUser(user), sessionToken };
}

export async function listUsers(): Promise<Omit<AuthUser, "passwordHash">[]> {
  const store = await readStore();
  return store.users.map((user) => safeUser(user));
}

export async function getUserById(userId: string): Promise<Omit<AuthUser, "passwordHash"> | null> {
  const store = await readStore();
  const user = store.users.find((entry) => entry.id === userId);
  return user ? safeUser(user) : null;
}

export function verifySessionToken(token: string): AuthSessionClaims {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new BackendError("Malformed session token", 401);
  }
  const payload = JSON.parse(Buffer.from(base64UrlDecode(parts[1])).toString("utf8")) as Record<string, unknown>;
  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, "ascii");
  const expected = sign(requireSessionSecret(), signingInput);
  const actual = base64UrlDecode(parts[2]);
  if (!Buffer.from(expected).equals(Buffer.from(actual))) {
    throw new BackendError("Invalid session signature", 401);
  }
  const claims: AuthSessionClaims = {
    userId: String(payload.sub ?? ""),
    email: String(payload.email ?? ""),
    name: String(payload.name ?? ""),
    tenantId: String(payload.tenant_id ?? ""),
    role: payload.role === "admin" ? "admin" : "user",
    readRoots: Array.isArray(payload.read_roots) ? payload.read_roots.map(String) : ["."],
    writeRoots: Array.isArray(payload.write_roots) ? payload.write_roots.map(String) : ["."],
    issuedAt: Number(payload.iat ?? 0),
    expiresAt: Number(payload.exp ?? 0),
  };
  const now = nowSeconds();
  if (!claims.userId || !claims.email || !claims.tenantId) {
    throw new BackendError("Invalid session payload", 401);
  }
  if (claims.expiresAt <= now) {
    throw new BackendError("Session expired", 401);
  }
  return claims;
}

export function extractSessionToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim() || null;
  }
  const cookies = parseCookieHeader(request.headers.get("cookie"));
  return cookies[SESSION_COOKIE_NAME] ?? null;
}

export async function requireUserSession(request: Request): Promise<AuthSessionClaims> {
  const token = extractSessionToken(request);
  if (!token) {
    throw new BackendError("Authentication required", 401);
  }
  return verifySessionToken(token);
}

export function sessionCookie(token: string): string {
  const maxAge = SESSION_TTL_SECONDS;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function clearSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`;
}

