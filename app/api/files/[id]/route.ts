import { NextResponse } from "next/server";
import {
  BackendError,
  createVault,
  deletePath,
  getItemMetadata,
  getPathForFileId,
  loadLockSet,
  listFileIdsUnderPath,
  movePath,
  pathWithinRoots,
  qdrantDeleteFile,
  qdrantUpdateFile,
  readFile,
  writeFile,
  appendFile,
} from "../../../lib/backend";
import { requireUserSession } from "../../../lib/user_auth";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

function errorResponse(error: unknown): NextResponse {
  if (error instanceof BackendError) {
    const backendError = error as BackendError;
    return NextResponse.json({ error: backendError.message }, { status: backendError.status });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return NextResponse.json({ error: message }, { status: 500 });
}

async function resolveFile(vaultRoot: string, fileId: string): Promise<string> {
  const rel = await getPathForFileId(vaultRoot, fileId);
  if (!rel) {
    throw new BackendError(`Unknown file_id: ${fileId}`, 404);
  }
  return rel;
}

export async function GET(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const claims = await requireUserSession(request);
    const vaultRoot = await createVault(claims.tenantId);
    const relativePath = await resolveFile(vaultRoot, id);
    if (!pathWithinRoots(relativePath, claims.readRoots)) {
      throw new BackendError(`Read is restricted outside the token's allowed folders: ${relativePath}`, 403);
    }

    const metadata = await getItemMetadata(vaultRoot, relativePath);
    const content = metadata.kind === "file" ? await readFile(vaultRoot, await loadLockSet(vaultRoot), relativePath) : null;
    return NextResponse.json({ ...metadata, content });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const claims = await requireUserSession(request);
    const body: any = await request.json().catch(() => ({}));
    const vaultRoot = await createVault(claims.tenantId);
    const locks = await loadLockSet(vaultRoot);
    const currentPath = await resolveFile(vaultRoot, id);
    const nextPath = typeof body?.path === "string" && body.path.trim() ? String(body.path).trim() : currentPath;

    if (!pathWithinRoots(currentPath, claims.writeRoots)) {
      throw new BackendError(`Write is restricted outside the token's allowed folders: ${currentPath}`, 403);
    }
    if (!pathWithinRoots(nextPath, claims.writeRoots)) {
      throw new BackendError(`Write is restricted outside the token's allowed folders: ${nextPath}`, 403);
    }

    if (nextPath !== currentPath) {
      await movePath(vaultRoot, locks, currentPath, nextPath);
    }

    const hasContent = Object.prototype.hasOwnProperty.call(body, "content");
    const appendMode = body?.append === true;
    if (hasContent) {
      const content = String(body?.content ?? "");
      if (appendMode) {
        await appendFile(vaultRoot, locks, nextPath, content);
      } else {
        await writeFile(vaultRoot, locks, nextPath, content);
      }
      await qdrantUpdateFile({
        tenantId: claims.tenantId,
        fileId: id,
        content: await readFile(vaultRoot, locks, nextPath),
        embeddingModel: String(body?.embedding_model ?? "jasper-token-compression-600m"),
      });
    }

    const metadata = await getItemMetadata(vaultRoot, nextPath);
    return NextResponse.json({
      updated: true,
      file_id: id,
      path: nextPath,
      metadata,
      content: metadata.kind === "file" ? await readFile(vaultRoot, locks, nextPath) : null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const claims = await requireUserSession(request);
    const vaultRoot = await createVault(claims.tenantId);
    const locks = await loadLockSet(vaultRoot);
    const relativePath = await resolveFile(vaultRoot, id);
    if (!pathWithinRoots(relativePath, claims.writeRoots)) {
      throw new BackendError(`Write is restricted outside the token's allowed folders: ${relativePath}`, 403);
    }

    const fileIds = await listFileIdsUnderPath(vaultRoot, relativePath);
    await deletePath(vaultRoot, locks, relativePath);
    if (fileIds.length) {
      await Promise.all(fileIds.map((fileId) => qdrantDeleteFile(claims.tenantId, fileId)));
    }
    return NextResponse.json({ deleted: true, file_id: id, path: relativePath });
  } catch (error) {
    return errorResponse(error);
  }
}
