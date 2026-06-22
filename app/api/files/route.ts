import { NextResponse } from "next/server";
import {
  BackendError,
  buildTreeSnapshot,
  createFolder,
  createVault,
  getVaultUsageBytes,
  ensureFileId,
  ensureFolderId,
  listFolderContents,
  loadLockSet,
  pathWithinRoots,
  qdrantUpdateFile,
  readFile,
  writeFile,
} from "../../lib/backend";
import { requireUserSession } from "../../lib/user_auth";

export const runtime = "nodejs";

function errorResponse(error: unknown): NextResponse {
  if (error instanceof BackendError) {
    const backendError = error as BackendError;
    return NextResponse.json({ error: backendError.message }, { status: backendError.status });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const claims = await requireUserSession(request);
    const url = new URL(request.url);
    const relativePath = url.searchParams.get("path") ?? ".";
    const view = url.searchParams.get("view") ?? "tree";
    const vaultRoot = await createVault(claims.tenantId);
    const locks = await loadLockSet(vaultRoot);

    if (!pathWithinRoots(relativePath, claims.readRoots)) {
      throw new BackendError(`Read is restricted outside the token's allowed folders: ${relativePath}`, 403);
    }

    const data =
      view === "list"
        ? await listFolderContents(vaultRoot, relativePath)
        : await buildTreeSnapshot(vaultRoot, relativePath);

    return NextResponse.json({
      tenant_id: claims.tenantId,
      path: relativePath,
      view,
      locked_paths: Array.from(locks),
      usage_bytes: await getVaultUsageBytes(vaultRoot),
      max_bytes: 100 * 1024 * 1024,
      data,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const claims = await requireUserSession(request);
    const body: any = await request.json().catch(() => ({}));
    const kind = String(body?.kind ?? "file");
    const relativePath = String(body?.path ?? "").trim();
    const content = String(body?.content ?? "");
    if (!relativePath) {
      throw new BackendError("Missing path", 400);
    }
    if (!pathWithinRoots(relativePath, claims.writeRoots)) {
      throw new BackendError(`Write is restricted outside the token's allowed folders: ${relativePath}`, 403);
    }

    const vaultRoot = await createVault(claims.tenantId);
    if (kind === "folder") {
      const folderPath = await createFolder(vaultRoot, await loadLockSet(vaultRoot), relativePath);
      return NextResponse.json({ created: true, kind: "folder", path: folderPath, file_id: null, folder_id: await ensureFolderId(vaultRoot, relativePath) });
    }

    const filePath = await writeFile(vaultRoot, await loadLockSet(vaultRoot), relativePath, content);
    const fileId = await ensureFileId(vaultRoot, relativePath);
    if (content) {
      await qdrantUpdateFile({
        tenantId: claims.tenantId,
        fileId,
        content,
        embeddingModel: String(body?.embedding_model ?? "jasper-token-compression-600m"),
      });
    }
    return NextResponse.json({
      created: true,
      kind: "file",
      path: filePath,
      file_id: fileId,
      folder_id: null,
      content: await readFile(vaultRoot, await loadLockSet(vaultRoot), relativePath),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
