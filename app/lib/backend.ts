import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export class BackendError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "BackendError";
    this.status = status;
  }
}

export type TokenClaims = {
  tenantId: string;
  tokenName: string;
  subject: string;
  scopes: string[];
  readRoots: string[];
  writeRoots: string[];
  jwtId: string;
  issuedAt: number;
  expiresAt: number;
  issuer: string;
  audience: string;
};

export type FileNode = {
  name: string;
  relativePath: string;
  kind: "file" | "folder";
  locked: boolean;
  fileId?: string | null;
  sizeBytes?: number | null;
  createdAt?: number | null;
  modifiedAt?: number | null;
  children?: FileNode[];
};

type Catalog = {
  files: Record<string, { path: string; created_at: number; updated_at: number }>;
  paths: Record<string, string>;
  updated_at: number;
};

type QdrantPoint = {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
};

const DEFAULT_ROOT = path.join(process.cwd(), "vaults");
const LOCK_FILE_NAME = ".vault-locks.json";
const CATALOG_FILE_NAME = ".vault-index.json";
const ROOT_MARKER_NAME = ".vault.json";
const MAX_VAULT_BYTES = 100 * 1024 * 1024;
const DEFAULT_JASPER_URL = process.env.JASPER_EMBEDDER_URL ?? "http://localhost:8001";
const DEFAULT_QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const DEFAULT_COLLECTION = process.env.QDRANT_COLLECTION ?? "vault_chunks";
const DEFAULT_VECTOR_SIZE = Number(process.env.QDRANT_VECTOR_SIZE ?? "2048");

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, "base64"));
}

function canonicalJson(value: Record<string, unknown>): Uint8Array {
  return Buffer.from(JSON.stringify(value, Object.keys(value).sort()), "utf8");
}

function sign(secret: string, signingInput: Uint8Array): Uint8Array {
  return createHmac("sha256", secret).update(signingInput).digest();
}

function jwtSecret(): string {
  const secret = process.env.MCP_JWT_SECRET;
  if (!secret) {
    throw new BackendError("MCP_JWT_SECRET is required", 500);
  }
  return secret;
}

function defaultIssuer(): string {
  return process.env.MCP_JWT_ISSUER ?? "brAIn-mcp";
}

function defaultAudience(): string {
  return process.env.MCP_JWT_AUDIENCE ?? "brAIn-mcp";
}

function revocationPath(): string {
  return process.env.MCP_JWT_REVOCATION_PATH ?? path.join(DEFAULT_ROOT, ".mcp-jwt-revocations.json");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function normalizeRelPath(value: string): string {
  const raw = value.trim().replace(/\\/g, "/");
  if (!raw || raw === ".") {
    return ".";
  }
  if (raw.startsWith("/")) {
    throw new BackendError("Paths must be relative to the vault root", 400);
  }
  const parts = raw.split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) {
    throw new BackendError("Parent directory references are not allowed", 400);
  }
  return parts.join("/");
}

function resolveWithinRoot(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (!resolvedCandidate.startsWith(resolvedRoot + path.sep) && resolvedCandidate !== resolvedRoot) {
    throw new BackendError(`Path escapes vault root: ${resolvedCandidate}`, 400);
  }
  return resolvedCandidate;
}

function vaultRootForTenant(tenantId: string): string {
  return resolveWithinRoot(DEFAULT_ROOT, path.join(DEFAULT_ROOT, tenantId));
}

async function readJson<T extends Record<string, unknown>>(file: string): Promise<T | Record<string, never>> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function atomicWrite(file: string, payload: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, payload, "utf8");
  await fs.rename(tmp, file);
}

async function loadCatalog(vaultRoot: string): Promise<Catalog> {
  const data = (await readJson<Record<string, unknown>>(path.join(vaultRoot, CATALOG_FILE_NAME))) as Record<string, unknown>;
  const files = data.files;
  const paths = data.paths;
  if (!files || typeof files !== "object" || !paths || typeof paths !== "object") {
    return { files: {}, paths: {}, updated_at: nowSeconds() };
  }
  return {
    files: files as Catalog["files"],
    paths: paths as Catalog["paths"],
    updated_at: Number(data.updated_at ?? nowSeconds()),
  };
}

async function saveCatalog(vaultRoot: string, catalog: Catalog): Promise<void> {
  await atomicWrite(
    path.join(vaultRoot, CATALOG_FILE_NAME),
    JSON.stringify(
      { files: catalog.files, paths: catalog.paths, updated_at: nowSeconds() },
      null,
      2,
    ) + "\n",
  );
}

export async function createFileRecord(vaultRoot: string, relativePath: string): Promise<string> {
  const rel = normalizeRelPath(relativePath);
  const catalog = await loadCatalog(vaultRoot);
  if (catalog.paths[rel]) {
    throw new BackendError(`File already exists in catalog: ${rel}`, 409);
  }
  const fileId = randomUUID();
  const ts = nowSeconds();
  catalog.files[fileId] = { path: rel, created_at: ts, updated_at: ts };
  catalog.paths[rel] = fileId;
  await saveCatalog(vaultRoot, catalog);
  return fileId;
}

export async function ensureFileId(vaultRoot: string, relativePath: string): Promise<string> {
  const rel = normalizeRelPath(relativePath);
  const catalog = await loadCatalog(vaultRoot);
  const existing = catalog.paths[rel];
  if (existing && catalog.files[existing]) {
    return existing;
  }
  return createFileRecord(vaultRoot, rel);
}

export async function getFileIdForPath(vaultRoot: string, relativePath: string): Promise<string | null> {
  const rel = normalizeRelPath(relativePath);
  const catalog = await loadCatalog(vaultRoot);
  return catalog.paths[rel] ?? null;
}

export async function getPathForFileId(vaultRoot: string, fileId: string): Promise<string | null> {
  const catalog = await loadCatalog(vaultRoot);
  const record = catalog.files[fileId];
  return record?.path ?? null;
}

export async function setFilePath(vaultRoot: string, fileId: string, relativePath: string): Promise<void> {
  const rel = normalizeRelPath(relativePath);
  const catalog = await loadCatalog(vaultRoot);
  const record = catalog.files[fileId];
  if (!record) {
    throw new BackendError(`Unknown file_id: ${fileId}`, 404);
  }
  const oldPath = record.path;
  if (oldPath && catalog.paths[oldPath] === fileId) {
    delete catalog.paths[oldPath];
  }
  record.path = rel;
  record.updated_at = nowSeconds();
  catalog.paths[rel] = fileId;
  await saveCatalog(vaultRoot, catalog);
}

export async function removePath(vaultRoot: string, relativePath: string): Promise<void> {
  const rel = normalizeRelPath(relativePath);
  if (rel === ".") {
    return;
  }
  const catalog = await loadCatalog(vaultRoot);
  for (const [fileId, record] of Object.entries(catalog.files)) {
    if (record.path === rel || record.path.startsWith(rel + "/")) {
      delete catalog.files[fileId];
      if (catalog.paths[record.path] === fileId) {
        delete catalog.paths[record.path];
      }
    }
  }
  await saveCatalog(vaultRoot, catalog);
}

export async function renamePath(vaultRoot: string, oldRelativePath: string, newRelativePath: string): Promise<void> {
  const oldRel = normalizeRelPath(oldRelativePath);
  const newRel = normalizeRelPath(newRelativePath);
  const catalog = await loadCatalog(vaultRoot);
  for (const [fileId, record] of Object.entries(catalog.files)) {
    if (record.path === oldRel || record.path.startsWith(oldRel + "/")) {
      const suffix = record.path.slice(oldRel.length).replace(/^\//, "");
      const updated = suffix ? `${newRel}/${suffix}` : newRel;
      if (catalog.paths[record.path] === fileId) {
        delete catalog.paths[record.path];
      }
      record.path = updated;
      record.updated_at = nowSeconds();
      catalog.paths[updated] = fileId;
    }
  }
  await saveCatalog(vaultRoot, catalog);
}

export async function listFileIdsUnderPath(vaultRoot: string, relativePath: string): Promise<string[]> {
  const rel = normalizeRelPath(relativePath);
  const catalog = await loadCatalog(vaultRoot);
  return Object.entries(catalog.files)
    .filter(([, record]) => record.path === rel || record.path.startsWith(rel + "/"))
    .map(([fileId]) => fileId);
}

export async function listPathsUnderPath(vaultRoot: string, relativePath: string): Promise<string[]> {
  const rel = normalizeRelPath(relativePath);
  const catalog = await loadCatalog(vaultRoot);
  return Object.values(catalog.files)
    .filter((record) => record.path === rel || record.path.startsWith(rel + "/"))
    .map((record) => record.path);
}

async function loadLockManifest(vaultRoot: string): Promise<Set<string>> {
  const data = (await readJson<Record<string, unknown>>(path.join(vaultRoot, LOCK_FILE_NAME))) as Record<string, unknown>;
  const locked = Array.isArray(data.locked_paths) ? data.locked_paths : [];
  return new Set(locked.map((item) => String(item)));
}

async function saveLockManifest(vaultRoot: string, lockedPaths: Iterable<string>): Promise<void> {
  await atomicWrite(
    path.join(vaultRoot, LOCK_FILE_NAME),
    JSON.stringify({ locked_paths: Array.from(new Set(Array.from(lockedPaths))).sort() }, null, 2) + "\n",
  );
}

function isLocked(relKey: string, locks: Set<string>): boolean {
  if (!relKey || relKey === ".") {
    return locks.has(".") || locks.has("");
  }
  const parts = relKey.split("/");
  let prefix = "";
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    if (locks.has(prefix) || locks.has(".")) {
      return true;
    }
  }
  return false;
}

function assertUnlocked(relKey: string, locks: Set<string>): void {
  if (isLocked(relKey, locks)) {
    throw new BackendError(`Path is locked: ${relKey}`, 423);
  }
}

export async function createVault(tenantId: string, displayName = "Vault"): Promise<string> {
  const vaultRoot = vaultRootForTenant(tenantId);
  await fs.mkdir(vaultRoot, { recursive: true });
  const rootMarker = path.join(vaultRoot, ROOT_MARKER_NAME);
  try {
    await fs.access(rootMarker);
  } catch {
    await atomicWrite(rootMarker, JSON.stringify({ user_id: tenantId, display_name: displayName }, null, 2) + "\n");
  }
  const locks = await loadLockManifest(vaultRoot);
  await saveLockManifest(vaultRoot, locks);
  return vaultRoot;
}

export async function getVaultRoot(tenantId: string): Promise<string> {
  const vaultRoot = vaultRootForTenant(tenantId);
  await fs.mkdir(vaultRoot, { recursive: true });
  return vaultRoot;
}

async function ensureParentExists(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function getVaultUsageBytes(vaultRoot: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        if ([LOCK_FILE_NAME, ROOT_MARKER_NAME, CATALOG_FILE_NAME].includes(entry.name)) {
          continue;
        }
        total += (await fs.stat(full)).size;
      } else if (entry.isDirectory()) {
        await walk(full);
      }
    }
  };
  await walk(vaultRoot);
  return total;
}

export async function createFolder(vaultRoot: string, locks: Set<string>, relativePath: string): Promise<string> {
  const rel = normalizeRelPath(relativePath);
  assertUnlocked(rel, locks);
  const target = resolveWithinRoot(vaultRoot, path.join(vaultRoot, rel));
  await ensureParentExists(target);
  await fs.mkdir(target, { recursive: false });
  return target;
}

export async function writeFile(vaultRoot: string, locks: Set<string>, relativePath: string, content: string): Promise<string> {
  const rel = normalizeRelPath(relativePath);
  assertUnlocked(rel, locks);
  const target = resolveWithinRoot(vaultRoot, path.join(vaultRoot, rel));
  await ensureParentExists(target);
  const currentUsage = await getVaultUsageBytes(vaultRoot);
  const currentSize = await fileSizeIfExists(target);
  const proposedSize = Buffer.byteLength(content, "utf8");
  const proposedUsage = currentUsage - currentSize + proposedSize;
  if (proposedUsage > MAX_VAULT_BYTES) {
    throw new BackendError(`Vault size limit exceeded: ${proposedUsage} bytes would exceed ${MAX_VAULT_BYTES} bytes`, 413);
  }
  await fs.writeFile(target, content, "utf8");
  await ensureFileId(vaultRoot, rel);
  return target;
}

export async function appendFile(vaultRoot: string, locks: Set<string>, relativePath: string, content: string): Promise<string> {
  const rel = normalizeRelPath(relativePath);
  assertUnlocked(rel, locks);
  const target = resolveWithinRoot(vaultRoot, path.join(vaultRoot, rel));
  await ensureParentExists(target);
  const current = await readFile(vaultRoot, locks, rel).catch(() => "");
  return writeFile(vaultRoot, locks, rel, current + content);
}

async function fileSizeIfExists(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return 0;
  }
}

export async function readFile(vaultRoot: string, locks: Set<string>, relativePath: string): Promise<string> {
  const rel = normalizeRelPath(relativePath);
  assertUnlocked(rel, locks);
  const target = resolveWithinRoot(vaultRoot, path.join(vaultRoot, rel));
  const stat = await fs.stat(target).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new BackendError(`File does not exist: ${relativePath}`, 404);
  }
  return fs.readFile(target, "utf8");
}

export async function pathExists(vaultRoot: string, relativePath: string): Promise<boolean> {
  const target = resolveWithinRoot(vaultRoot, path.join(vaultRoot, normalizeRelPath(relativePath)));
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function getItemMetadata(vaultRoot: string, relativePath: string): Promise<Record<string, unknown>> {
  const rel = normalizeRelPath(relativePath);
  const target = resolveWithinRoot(vaultRoot, path.join(vaultRoot, rel));
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) {
    throw new BackendError(`Path does not exist: ${relativePath}`, 404);
  }
  const isDir = stat.isDirectory();
  return {
    relative_path: rel,
    file_location: target,
    kind: isDir ? "folder" : "file",
    exists: true,
    locked: isLocked(rel, await loadLockManifest(vaultRoot)),
    size_bytes: isDir ? null : stat.size,
    created_at: Math.floor(stat.birthtimeMs / 1000),
    modified_at: Math.floor(stat.mtimeMs / 1000),
    file_id: isDir ? null : await getFileIdForPath(vaultRoot, rel),
  };
}

export async function listFolderContents(vaultRoot: string, relativePath = "."): Promise<FileNode[]> {
  const rel = normalizeRelPath(relativePath);
  const target = resolveWithinRoot(vaultRoot, path.join(vaultRoot, rel));
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) {
    throw new BackendError(`Path does not exist: ${relativePath}`, 404);
  }
  if (!stat.isDirectory()) {
    throw new BackendError(`Path is not a folder: ${relativePath}`, 400);
  }
  const locks = await loadLockManifest(vaultRoot);
  const entries = await fs.readdir(target, { withFileTypes: true });
  const filtered = entries.filter((item) => ![LOCK_FILE_NAME, ROOT_MARKER_NAME, CATALOG_FILE_NAME].includes(item.name));
  const nodes: FileNode[] = [];
  for (const item of filtered.sort((a, b) => Number(b.isFile()) - Number(a.isFile()) || a.name.localeCompare(b.name))) {
    const itemPath = rel === "." ? item.name : `${rel}/${item.name}`;
    const itemStat = await fs.stat(path.join(target, item.name));
    nodes.push({
      name: item.name,
      relativePath: itemPath,
      kind: item.isDirectory() ? "folder" : "file",
      locked: isLocked(itemPath, locks),
      fileId: item.isFile() ? await getFileIdForPath(vaultRoot, itemPath) : null,
      sizeBytes: item.isFile() ? itemStat.size : null,
      modifiedAt: Math.floor(itemStat.mtimeMs / 1000),
    });
  }
  return nodes;
}

export async function buildTreeSnapshot(vaultRoot: string, relativePath = "."): Promise<FileNode> {
  const rel = normalizeRelPath(relativePath);
  const target = resolveWithinRoot(vaultRoot, path.join(vaultRoot, rel));
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) {
    throw new BackendError(`Path does not exist: ${relativePath}`, 404);
  }
  const locks = await loadLockManifest(vaultRoot);
  const isDir = stat.isDirectory();
  const node: FileNode = {
    name: rel === "." ? path.basename(vaultRoot) : path.basename(target),
    relativePath: rel,
    kind: isDir ? "folder" : "file",
    locked: isLocked(rel, locks),
    fileId: isDir ? null : await getFileIdForPath(vaultRoot, rel),
    sizeBytes: isDir ? null : stat.size,
    createdAt: Math.floor(stat.birthtimeMs / 1000),
    modifiedAt: Math.floor(stat.mtimeMs / 1000),
  };
  if (isDir) {
    const children = await listFolderContents(vaultRoot, rel);
    node.children = [];
    for (const child of children) {
      if (child.kind === "folder") {
        node.children.push(await buildTreeSnapshot(vaultRoot, child.relativePath));
      } else {
        node.children.push(child);
      }
    }
  }
  return node;
}

export async function deletePath(vaultRoot: string, locks: Set<string>, relativePath: string): Promise<string> {
  const rel = normalizeRelPath(relativePath);
  if (rel === ".") {
    throw new BackendError("Cannot delete the vault root", 400);
  }
  assertUnlocked(rel, locks);
  const target = resolveWithinRoot(vaultRoot, path.join(vaultRoot, rel));
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) {
    throw new BackendError(`Path does not exist: ${relativePath}`, 404);
  }
  if (stat.isDirectory()) {
    await fs.rm(target, { recursive: true, force: true });
  } else {
    await fs.unlink(target);
  }
  await removePath(vaultRoot, rel);
  return target;
}

export async function movePath(vaultRoot: string, locks: Set<string>, source: string, destination: string): Promise<{ source: string; destination: string }> {
  const sourceRel = normalizeRelPath(source);
  const destRel = normalizeRelPath(destination);
  if (sourceRel === "." || destRel === ".") {
    throw new BackendError("Cannot move the vault root", 400);
  }
  assertUnlocked(sourceRel, locks);
  assertUnlocked(destRel, locks);
  const src = resolveWithinRoot(vaultRoot, path.join(vaultRoot, sourceRel));
  const dst = resolveWithinRoot(vaultRoot, path.join(vaultRoot, destRel));
  await ensureParentExists(dst);
  await fs.rename(src, dst);
  await renamePath(vaultRoot, sourceRel, destRel);
  return { source: src, destination: dst };
}

export function chunkMarkdown(content: string, maxChars = 1800): string[] {
  const lines = content.split(/\r?\n/);
  const chunks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (!current.length) return;
    const chunk = current.join("\n").trim();
    if (chunk) chunks.push(chunk);
    current = [];
  };
  for (const line of lines) {
    if (line.trimStart().startsWith("#") && current.length) flush();
    current.push(line);
    if (current.join("\n").length >= maxChars) flush();
  }
  flush();
  if (chunks.length) return chunks;
  const text = content.trim();
  if (!text) return [""];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) out.push(text.slice(i, i + maxChars));
  return out;
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  const response = await fetch(`${DEFAULT_JASPER_URL}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts }),
  });
  if (!response.ok) {
    throw new BackendError(`Embedder request failed: ${response.status} ${await response.text()}`, 502);
  }
  const data = (await response.json()) as { vectors?: number[][] };
  if (!Array.isArray(data.vectors)) {
    throw new BackendError("Embedder returned an invalid vectors payload", 502);
  }
  return data.vectors;
}

async function qdrantRequest(method: string, endpoint: string, payload?: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${DEFAULT_QDRANT_URL}${endpoint}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new BackendError(`Qdrant request failed: ${response.status} ${text}`, 502);
  }
  return response.headers.get("content-type")?.includes("application/json") ? response.json() : response.text();
}

async function ensureCollection(): Promise<void> {
  try {
    await qdrantRequest("PUT", `/collections/${DEFAULT_COLLECTION}`, {
      vectors: { size: DEFAULT_VECTOR_SIZE, distance: "Cosine" },
    });
  } catch (error: any) {
    const message = String(error?.message ?? error);
    if (!message.toLowerCase().includes("already exists")) {
      throw error;
    }
  }
}

function stablePointId(tenantId: string, fileId: string, chunkHash: string, occurrence: number): string {
  return createHmac("sha256", "qdrant-point")
    .update(`${tenantId}:${fileId}:${chunkHash}:${occurrence}`)
    .digest("hex");
}

export async function qdrantUpdateFile(options: {
  tenantId: string;
  fileId: string;
  content: string;
  embeddingModel: string;
  legacyFilePath?: string;
}): Promise<{ created_or_updated_chunks: number; deleted_chunks: number; existing_chunks: number }> {
  await ensureCollection();
  const { tenantId, fileId, content, embeddingModel, legacyFilePath } = options;
  const existing = await qdrantScrollFilePoints({ tenantId, fileId, legacyFilePath });
  const existingByKey = new Map<string, { id?: string }>();
  const existingIds = new Set<string>();
  const hashCounts = new Map<string, number>();
  for (const point of existing.sort((a, b) => Number(a.payload.chunk_index ?? 0) - Number(b.payload.chunk_index ?? 0))) {
    const chunkHash = String(point.payload.chunk_hash ?? "");
    const occurrence = hashCounts.get(chunkHash) ?? 0;
    hashCounts.set(chunkHash, occurrence + 1);
    existingByKey.set(`${chunkHash}:${occurrence}`, point);
    if (point.id) existingIds.add(String(point.id));
  }
  const chunks = chunkMarkdown(content);
  const vectors = await embedTexts(chunks);
  const newPoints: QdrantPoint[] = [];
  const newIds = new Set<string>();
  const newHashCounts = new Map<string, number>();
  for (let index = 0; index < chunks.length; index++) {
    const chunkText = chunks[index]!;
    const vector = vectors[index] ?? [];
    const chunkHash = createHmac("sha256", "chunk").update(chunkText).digest("hex");
    const occurrence = newHashCounts.get(chunkHash) ?? 0;
    newHashCounts.set(chunkHash, occurrence + 1);
    const existingPoint = existingByKey.get(`${chunkHash}:${occurrence}`);
    const pointId = existingPoint?.id ?? stablePointId(tenantId, fileId, chunkHash, occurrence);
    newIds.add(pointId);
    newPoints.push({
      id: pointId,
      vector,
      payload: {
        tenant_id: tenantId,
        file_id: fileId,
        chunk_index: index,
        embedding_model: embeddingModel,
        chunk_hash: chunkHash,
      },
    });
  }
  const pointsToDelete = Array.from(existingIds).filter((id) => !newIds.has(id));
  if (pointsToDelete.length) {
    await qdrantRequest("POST", `/collections/${DEFAULT_COLLECTION}/points/delete`, {
      points: pointsToDelete,
      wait: true,
    });
  }
  if (newPoints.length) {
    await qdrantRequest("PUT", `/collections/${DEFAULT_COLLECTION}/points`, { points: newPoints, wait: true });
  }
  return {
    created_or_updated_chunks: newPoints.length,
    deleted_chunks: pointsToDelete.length,
    existing_chunks: existing.length,
  };
}

async function qdrantScrollFilePoints(options: { tenantId: string; fileId: string; legacyFilePath?: string }): Promise<any[]> {
  const { tenantId, fileId, legacyFilePath } = options;
  const points: any[] = [];
  let offset: unknown = undefined;
  while (true) {
    const filter: Record<string, unknown> = { must: [{ key: "tenant_id", match: { value: tenantId } }] };
    if (legacyFilePath) {
      filter.should = [
        { key: "file_id", match: { value: fileId } },
        { key: "file_path", match: { value: legacyFilePath } },
      ];
      filter.min_should = 1;
    } else {
      (filter.must as any[]).push({ key: "file_id", match: { value: fileId } });
    }
    const payload: Record<string, unknown> = { limit: 100, with_payload: true, with_vector: false, filter };
    if (offset !== undefined) payload.offset = offset;
    const data = await qdrantRequest("POST", `/collections/${DEFAULT_COLLECTION}/points/scroll`, payload);
    const result = data?.result ?? {};
    const batch = Array.isArray(result.points) ? result.points : [];
    points.push(...batch);
    offset = result.next_page_offset;
    if (!offset || !batch.length) break;
  }
  return points;
}

export async function qdrantDeleteFile(tenantId: string, fileId: string): Promise<void> {
  await qdrantRequest("POST", `/collections/${DEFAULT_COLLECTION}/points/delete`, {
    filter: { must: [{ key: "tenant_id", match: { value: tenantId } }, { key: "file_id", match: { value: fileId } }] },
    wait: true,
  });
}

export async function qdrantDeleteFiles(tenantId: string, fileIds: string[]): Promise<number> {
  let deleted = 0;
  for (const fileId of fileIds) {
    await qdrantDeleteFile(tenantId, fileId);
    deleted += 1;
  }
  return deleted;
}

export async function qdrantDeletePaths(tenantId: string, paths: string[]): Promise<number> {
  let deleted = 0;
  for (const rel of paths) {
    await qdrantRequest("POST", `/collections/${DEFAULT_COLLECTION}/points/delete`, {
      filter: { must: [{ key: "tenant_id", match: { value: tenantId } }, { key: "file_path", match: { value: rel } }] },
      wait: true,
    });
    deleted += 1;
  }
  return deleted;
}

export async function qdrantSearch(options: { tenantId: string; queryVector: number[]; topK: number }): Promise<any[]> {
  await ensureCollection();
  const data = await qdrantRequest("POST", `/collections/${DEFAULT_COLLECTION}/points/search`, {
    vector: options.queryVector,
    limit: options.topK,
    with_payload: true,
    filter: { must: [{ key: "tenant_id", match: { value: options.tenantId } }] },
  });
  const results = Array.isArray(data?.result) ? data.result : [];
  return results.map((item: any) => ({
    id: item.id,
    score: Number(item.score ?? 0),
    file_id: item.payload?.file_id,
    legacy_file_path: item.payload?.file_path,
    chunk_index: item.payload?.chunk_index,
    embedding_model: item.payload?.embedding_model,
  }));
}

export async function embedText(text: string): Promise<number[]> {
  return (await embedTexts([text]))[0] ?? [];
}

export async function embedPayload(texts: string[]): Promise<{ model_name: string; dimension: number; vectors: number[][] }> {
  const response = await fetch(`${DEFAULT_JASPER_URL}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts }),
  });
  if (!response.ok) {
    throw new BackendError(`Embedder request failed: ${response.status} ${await response.text()}`, 502);
  }
  const data = (await response.json()) as { model_name?: string; dimension?: number; vectors?: number[][] };
  if (!Array.isArray(data.vectors)) {
    throw new BackendError("Embedder returned an invalid vectors payload", 502);
  }
  return {
    model_name: String(data.model_name ?? ""),
    dimension: Number(data.dimension ?? DEFAULT_VECTOR_SIZE),
    vectors: data.vectors,
  };
}

export async function embedMetadata(): Promise<Record<string, unknown>> {
  const response = await fetch(`${DEFAULT_JASPER_URL}/metadata`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (!response.ok) {
    throw new BackendError(`Embedder metadata request failed: ${response.status} ${await response.text()}`, 502);
  }
  return (await response.json()) as Record<string, unknown>;
}

export function pathWithinRoots(pathName: string, roots: string[]): boolean {
  if (!roots.length) return true;
  const candidate = normalizeRelPath(pathName);
  for (const root of roots) {
    const allowed = normalizeRelPath(root);
    if (allowed === ".") return true;
    if (candidate === allowed || candidate.startsWith(`${allowed}/`)) return true;
  }
  return false;
}

export function assertPathAllowed(pathName: string, roots: string[], action: string): void {
  if (!pathWithinRoots(pathName, roots)) {
    throw new BackendError(`${action} is restricted outside the token's allowed folders: ${pathName}`, 403);
  }
}

export async function loadLockSet(vaultRoot: string): Promise<Set<string>> {
  const data = (await readJson<Record<string, unknown>>(path.join(vaultRoot, LOCK_FILE_NAME))) as Record<string, unknown>;
  const locked = Array.isArray(data.locked_paths) ? data.locked_paths : [];
  return new Set(locked.map(String));
}

export async function saveLockSet(vaultRoot: string, locked: Iterable<string>): Promise<void> {
  await atomicWrite(path.join(vaultRoot, LOCK_FILE_NAME), JSON.stringify({ locked_paths: Array.from(new Set(locked)).sort() }, null, 2) + "\n");
}

export async function issueToken(options: {
  tenantId: string;
  tokenName: string;
  subject: string;
  scopes: string[];
  readRoots?: string[] | null;
  writeRoots?: string[] | null;
  ttlDays?: number;
  audience?: string | null;
  issuer?: string | null;
}): Promise<string> {
  const now = nowSeconds();
  let readRoots = options.readRoots ?? null;
  let writeRoots = options.writeRoots ?? null;
  if (!readRoots && writeRoots) readRoots = [...writeRoots];
  if (!writeRoots && readRoots) writeRoots = [...readRoots];
  const payload: Record<string, unknown> = {
    iss: options.issuer ?? defaultIssuer(),
    aud: options.audience ?? defaultAudience(),
    sub: options.subject,
    tenant_id: options.tenantId,
    token_name: options.tokenName,
    scopes: options.scopes,
    jti: randomUUID(),
    iat: now,
    nbf: now,
    exp: now + (options.ttlDays ?? 365) * 24 * 60 * 60,
    v: 1,
  };
  if (readRoots?.length) payload.read_roots = readRoots;
  if (writeRoots?.length) payload.write_roots = writeRoots;
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput = `${base64UrlEncode(canonicalJson(header))}.${base64UrlEncode(canonicalJson(payload))}`;
  const signature = sign(jwtSecret(), Buffer.from(signingInput, "ascii"));
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

export async function verifyToken(token: string): Promise<TokenClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new BackendError("Malformed JWT", 401);
  }
  const header = JSON.parse(Buffer.from(base64UrlDecode(parts[0])).toString("utf8")) as Record<string, unknown>;
  const payload = JSON.parse(Buffer.from(base64UrlDecode(parts[1])).toString("utf8")) as Record<string, unknown>;
  if (header.alg !== "HS256") {
    throw new BackendError("Unsupported JWT algorithm", 401);
  }
  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, "ascii");
  const expected = sign(jwtSecret(), signingInput);
  const actual = base64UrlDecode(parts[2]);
  if (!Buffer.from(expected).equals(Buffer.from(actual))) {
    throw new BackendError("Invalid JWT signature", 401);
  }
  const claims: TokenClaims = {
    tenantId: String(payload.tenant_id ?? ""),
    tokenName: String(payload.token_name ?? ""),
    subject: String(payload.sub ?? ""),
    scopes: Array.isArray(payload.scopes) ? payload.scopes.map(String) : [],
    readRoots: Array.isArray(payload.read_roots) ? payload.read_roots.map(String) : Array.isArray(payload.allowed_paths) ? payload.allowed_paths.map(String) : [],
    writeRoots: Array.isArray(payload.write_roots) ? payload.write_roots.map(String) : Array.isArray(payload.allowed_paths) ? payload.allowed_paths.map(String) : [],
    jwtId: String(payload.jti ?? ""),
    issuedAt: Number(payload.iat ?? 0),
    expiresAt: Number(payload.exp ?? 0),
    issuer: String(payload.iss ?? ""),
    audience: String(payload.aud ?? ""),
  };
  const now = nowSeconds();
  if (claims.issuedAt > now + 60) throw new BackendError("JWT issued in the future", 401);
  if (claims.expiresAt <= now) throw new BackendError("JWT expired", 401);
  if (payload.nbf !== undefined && Number(payload.nbf) > now) throw new BackendError("JWT not yet valid", 401);
  if (claims.issuer !== defaultIssuer()) throw new BackendError("JWT issuer mismatch", 401);
  if (claims.audience !== defaultAudience()) throw new BackendError("JWT audience mismatch", 401);
  const revoked = await readJson<Record<string, unknown>>(revocationPath());
  const revokedMap = (revoked.revoked as Record<string, unknown>) ?? {};
  const revokedEntry = revokedMap[claims.jwtId] as Record<string, unknown> | undefined;
  if (revokedEntry && Number(revokedEntry.revoked_at ?? 0) > 0) {
    throw new BackendError("JWT has been revoked", 401);
  }
  return claims;
}

export function requireScope(claims: TokenClaims, scope: string): void {
  if (!claims.scopes.includes(scope)) {
    throw new BackendError(`JWT lacks required scope: ${scope}`, 403);
  }
}

export function buildTools() {
  return [
    { name: "create_item", description: "Create a file or folder inside an authorized tenant vault and index stable file IDs in Qdrant." },
    { name: "read_item", description: "Embed a natural-language request and return the best matching file ID, location, and content." },
    { name: "search_item", description: "Embed a natural-language request and return matching file IDs and locations without reading file contents." },
    { name: "update_item", description: "Update an existing file in the vault and refresh the changed Qdrant chunks by file ID." },
    { name: "append_item", description: "Append text to a file in the vault and refresh its indexed chunks by file ID." },
    { name: "move_item", description: "Move a file or folder inside the vault and update the stable catalog path mapping." },
    { name: "delete_item", description: "Delete a file or folder from the vault and remove its indexed chunks by file ID." },
    { name: "get_item_metadata", description: "Return metadata for a file or folder in the vault without reading its content." },
    { name: "list_folder_contents", description: "List the immediate children of a folder in the vault." },
    { name: "exists_item", description: "Check whether a file or folder exists in the vault." },
  ];
}

