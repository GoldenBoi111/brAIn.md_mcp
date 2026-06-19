import { NextResponse } from "next/server";
import {
  BackendError,
  appendFile,
  buildTools,
  createFolder,
  createVault,
  deletePath,
  embedText,
  ensureFileId,
  getFileIdForPath,
  getItemMetadata,
  getPathForFileId,
  getTokenLockedPaths,
  listFolderContents,
  listFileIdsUnderPath,
  loadLockSet,
  isPathLocked,
  movePath,
  pathWithinRoots,
  qdrantDeleteFile,
  qdrantSearch,
  qdrantUpdateFile,
  readFile,
  verifyToken,
  writeFile,
} from "../lib/backend";

export const runtime = "nodejs";

type JsonRpcRequest = {
  id?: string | number | null;
  jsonrpc?: string;
  method?: string;
  params?: Record<string, unknown>;
};

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof BackendError) {
    const backendError = error as BackendError;
    return NextResponse.json({ error: backendError.message }, { status: backendError.status });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return NextResponse.json({ error: message }, { status: 500 });
}

async function requireClaims(request: Request) {
  const token = bearerToken(request);
  if (!token) {
    throw new BackendError("Missing bearer token", 401);
  }
  return verifyToken(token);
}

function assertTokenPathUnlocked(relativePath: string, lockedPaths: Set<string>): void {
  if (isPathLocked(relativePath, lockedPaths)) {
    throw new BackendError(`Path is locked for this token: ${relativePath}`, 423);
  }
}

async function resolvePathFromInput(vaultRoot: string, input: Record<string, unknown>): Promise<string> {
  const fileId = typeof input.file_id === "string" ? input.file_id : typeof input.fileId === "string" ? input.fileId : null;
  if (fileId) {
    const rel = await getPathForFileId(vaultRoot, fileId);
    if (!rel) {
      throw new BackendError(`Unknown file_id: ${fileId}`, 404);
    }
    return rel;
  }
  const pathValue = typeof input.path === "string" ? input.path : typeof input.relative_path === "string" ? input.relative_path : null;
  if (!pathValue) {
    throw new BackendError("Missing path or file_id", 400);
  }
  return pathValue;
}

async function resolveFileId(vaultRoot: string, pathValue: string): Promise<string> {
  const fileId = await getFileIdForPath(vaultRoot, pathValue);
  if (!fileId) {
    throw new BackendError(`Unknown file path: ${pathValue}`, 404);
  }
  return fileId;
}

async function callTool(claims: Awaited<ReturnType<typeof requireClaims>>, tokenLocks: Set<string>, toolName: string, args: Record<string, unknown>) {
  const vaultRoot = await createVault(claims.tenantId);
  const vaultLocks = await loadLockSet(vaultRoot);
  const locks = new Set<string>([...vaultLocks, ...tokenLocks]);

  switch (toolName) {
    case "create_item": {
      const kind = String(args.kind ?? "file");
      const pathValue = String(args.path ?? "").trim();
      const content = String(args.content ?? "");
      if (!pathValue) throw new BackendError("Missing path", 400);
      if (!pathWithinRoots(pathValue, claims.writeRoots)) {
        throw new BackendError(`Write is restricted outside the token's allowed folders: ${pathValue}`, 403);
      }
      assertTokenPathUnlocked(pathValue, locks);
      if (kind === "folder") {
        const folderPath = await createFolder(vaultRoot, locks, pathValue);
        return { kind: "folder", path: folderPath };
      }
      const filePath = await writeFile(vaultRoot, locks, pathValue, content);
      const fileId = await ensureFileId(vaultRoot, pathValue);
      if (content) {
        await qdrantUpdateFile({
          tenantId: claims.tenantId,
          fileId,
          content,
          embeddingModel: String(args.embedding_model ?? "jasper-token-compression-600m"),
        });
      }
      return { kind: "file", path: filePath, file_id: fileId };
    }
    case "read_item": {
      if (typeof args.query === "string" && args.query.trim()) {
        const hits = await qdrantSearch({
          tenantId: claims.tenantId,
          queryVector: await embedText(args.query.trim()),
          topK: Number.isFinite(Number(args.top_k)) ? Math.min(Number(args.top_k), 10) : 5,
        });
        const readable = [];
        for (const hit of hits) {
          const relativePath = hit.file_id ? await getPathForFileId(vaultRoot, hit.file_id) : hit.legacy_file_path ?? null;
          if (!relativePath || !pathWithinRoots(relativePath, claims.readRoots)) continue;
          if (isPathLocked(relativePath, locks)) continue;
          readable.push({
            file_id: hit.file_id,
            relative_path: relativePath,
            score: hit.score,
          });
        }
        if (!readable.length) return { query: args.query, matches: [] };
        const best = readable[0]!;
        const text = await readFile(vaultRoot, locks, best.relative_path);
        return { query: args.query, match: best, content: text };
      }

      const relativePath = await resolvePathFromInput(vaultRoot, args);
      if (!pathWithinRoots(relativePath, claims.readRoots)) {
        throw new BackendError(`Read is restricted outside the token's allowed folders: ${relativePath}`, 403);
      }
      assertTokenPathUnlocked(relativePath, locks);
      return {
        path: relativePath,
        file_id: await resolveFileId(vaultRoot, relativePath),
        metadata: await getItemMetadata(vaultRoot, relativePath),
        content: await readFile(vaultRoot, locks, relativePath),
      };
    }
    case "search_item": {
      const query = String(args.query ?? "").trim();
      if (!query) throw new BackendError("Missing query", 400);
      const hits = await qdrantSearch({
        tenantId: claims.tenantId,
        queryVector: await embedText(query),
        topK: Number.isFinite(Number(args.top_k)) ? Math.min(Number(args.top_k), 50) : 10,
      });
      const matches = [];
      for (const hit of hits) {
        const relativePath = hit.file_id ? await getPathForFileId(vaultRoot, hit.file_id) : hit.legacy_file_path ?? null;
        if (!relativePath || !pathWithinRoots(relativePath, claims.readRoots)) continue;
        if (isPathLocked(relativePath, locks)) continue;
        matches.push({ file_id: hit.file_id, relative_path: relativePath, score: hit.score });
      }
      return { query, matches };
    }
    case "update_item": {
      const relativePath = await resolvePathFromInput(vaultRoot, args);
      if (!pathWithinRoots(relativePath, claims.writeRoots)) {
        throw new BackendError(`Write is restricted outside the token's allowed folders: ${relativePath}`, 403);
      }
      assertTokenPathUnlocked(relativePath, locks);
      const content = String(args.content ?? "");
      const fileId = await resolveFileId(vaultRoot, relativePath);
      await writeFile(vaultRoot, locks, relativePath, content);
      await qdrantUpdateFile({
        tenantId: claims.tenantId,
        fileId,
        content,
        embeddingModel: String(args.embedding_model ?? "jasper-token-compression-600m"),
      });
      return { updated: true, path: relativePath, file_id: fileId };
    }
    case "append_item": {
      const relativePath = await resolvePathFromInput(vaultRoot, args);
      if (!pathWithinRoots(relativePath, claims.writeRoots)) {
        throw new BackendError(`Write is restricted outside the token's allowed folders: ${relativePath}`, 403);
      }
      assertTokenPathUnlocked(relativePath, locks);
      const content = String(args.content ?? "");
      const fileId = await resolveFileId(vaultRoot, relativePath);
      const existing = await readFile(vaultRoot, locks, relativePath).catch(() => "");
      const updatedContent = existing + content;
      await appendFile(vaultRoot, locks, relativePath, content);
      await qdrantUpdateFile({
        tenantId: claims.tenantId,
        fileId,
        content: updatedContent,
        embeddingModel: String(args.embedding_model ?? "jasper-token-compression-600m"),
      });
      return { appended: true, path: relativePath, file_id: fileId };
    }
    case "move_item": {
      const sourcePath = await resolvePathFromInput(vaultRoot, { ...args, path: args.source_path ?? args.source });
      const destinationPath = String(args.destination_path ?? args.destination ?? "").trim();
      if (!destinationPath) throw new BackendError("Missing destination_path", 400);
      if (!pathWithinRoots(sourcePath, claims.writeRoots) || !pathWithinRoots(destinationPath, claims.writeRoots)) {
        throw new BackendError("Move is restricted outside the token's allowed folders", 403);
      }
      assertTokenPathUnlocked(sourcePath, locks);
      assertTokenPathUnlocked(destinationPath, locks);
      const result = await movePath(vaultRoot, locks, sourcePath, destinationPath);
      return { moved: true, source: result.source, destination: result.destination };
    }
    case "delete_item": {
      const relativePath = await resolvePathFromInput(vaultRoot, args);
      if (!pathWithinRoots(relativePath, claims.writeRoots)) {
        throw new BackendError(`Write is restricted outside the token's allowed folders: ${relativePath}`, 403);
      }
      assertTokenPathUnlocked(relativePath, locks);
      const fileIds = await listFileIdsUnderPath(vaultRoot, relativePath);
      const fileId = await getFileIdForPath(vaultRoot, relativePath);
      await deletePath(vaultRoot, locks, relativePath);
      if (fileIds.length) {
        await Promise.all(fileIds.map((id: string) => qdrantDeleteFile(claims.tenantId, id)));
      } else if (fileId) {
        await qdrantDeleteFile(claims.tenantId, fileId);
      }
      return { deleted: true, path: relativePath, file_id: fileId };
    }
    case "get_item_metadata": {
      const relativePath = await resolvePathFromInput(vaultRoot, args);
      if (!pathWithinRoots(relativePath, claims.readRoots)) {
        throw new BackendError(`Read is restricted outside the token's allowed folders: ${relativePath}`, 403);
      }
      assertTokenPathUnlocked(relativePath, locks);
      return await getItemMetadata(vaultRoot, relativePath);
    }
    case "list_folder_contents": {
      const relativePath = String(args.path ?? ".");
      if (!pathWithinRoots(relativePath, claims.readRoots)) {
        throw new BackendError(`Read is restricted outside the token's allowed folders: ${relativePath}`, 403);
      }
      assertTokenPathUnlocked(relativePath, locks);
      return { path: relativePath, items: await listFolderContents(vaultRoot, relativePath) };
    }
    case "exists_item": {
      const relativePath = await resolvePathFromInput(vaultRoot, args);
      if (!pathWithinRoots(relativePath, claims.readRoots)) {
        throw new BackendError(`Read is restricted outside the token's allowed folders: ${relativePath}`, 403);
      }
      assertTokenPathUnlocked(relativePath, locks);
      try {
        return { exists: true, metadata: await getItemMetadata(vaultRoot, relativePath) };
      } catch {
        return { exists: false };
      }
    }
    default:
      throw new BackendError(`Unknown tool: ${toolName}`, 404);
  }
}

export async function POST(request: Request) {
  try {
    const claims = await requireClaims(request);
    const tokenLocks = new Set(await getTokenLockedPaths(claims.jwtId));
    const body = (await request.json().catch(() => ({}))) as JsonRpcRequest;

    if (body.method === "initialize") {
      return NextResponse.json({
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "brAIn.md MCP Server", version: "0.1.0" },
          capabilities: { tools: { listChanged: false } },
        },
      });
    }

    if (body.method === "tools/list") {
      return NextResponse.json({
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: { tools: buildTools() },
      });
    }

    if (body.method === "tools/call") {
      const name = String(body.params?.name ?? "");
      const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
      const result = await callTool(claims, tokenLocks, name, args);
      return NextResponse.json({
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result },
      });
    }

    throw new BackendError("Unsupported MCP method", 400);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET() {
  return NextResponse.json({
    route: "/mcp",
    methods: ["POST"],
    note: "POST JSON-RPC requests here with a bearer token.",
    jsonrpc_methods: ["initialize", "tools/list", "tools/call"],
  });
}
