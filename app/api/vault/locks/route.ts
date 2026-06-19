import { NextResponse } from "next/server";
import {
  BackendError,
  createVault,
  getLockedPaths,
  getPathForFileId,
  lockPath,
  pathWithinRoots,
  unlockPath,
} from "../../../lib/backend";
import { requireUserSession } from "../../../lib/user_auth";

export const runtime = "nodejs";

function errorResponse(error: unknown): NextResponse {
  if (error instanceof BackendError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return NextResponse.json({ error: message }, { status: 500 });
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

async function resolvePathForFileId(vaultRoot: string, fileId: string): Promise<string> {
  const relativePath = await getPathForFileId(vaultRoot, fileId);
  if (!relativePath) {
    throw new BackendError(`Unknown file_id: ${fileId}`, 404);
  }
  return relativePath;
}

async function resolveRequestedPath(vaultRoot: string, body: Record<string, unknown>): Promise<string | null> {
  const fileId = asString(body.file_id);
  if (fileId) {
    return resolvePathForFileId(vaultRoot, fileId);
  }
  return asString(body.path);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function collectPaths(vaultRoot: string, body: Record<string, unknown>): Promise<string[]>[] {
  const tasks: Promise<string[]>[] = [];
  const directPath = asString(body.path);
  if (directPath) {
    tasks.push(Promise.resolve([directPath]));
  }

  const directFileId = asString(body.file_id);
  if (directFileId) {
    tasks.push(resolvePathForFileId(vaultRoot, directFileId).then((path) => [path]));
  }

  const paths = Array.isArray(body.paths) ? body.paths : [];
  if (paths.length) {
    tasks.push(
      Promise.all(
        paths.map(async (value) => {
          const pathValue = asString(value);
          if (pathValue) {
            return pathValue;
          }
          const fileId = typeof value === "object" && value !== null ? asString((value as Record<string, unknown>).file_id) : null;
          if (fileId) {
            return resolvePathForFileId(vaultRoot, fileId);
          }
          throw new BackendError("Each lock target must be a path or file_id", 400);
        })
      )
    );
  }

  const fileIds = Array.isArray(body.file_ids) ? body.file_ids : [];
  if (fileIds.length) {
    tasks.push(
      Promise.all(
        fileIds.map(async (value) => {
          const fileId = asString(value);
          if (!fileId) {
            throw new BackendError("Each file_id must be a non-empty string", 400);
          }
          return resolvePathForFileId(vaultRoot, fileId);
        })
      )
    );
  }

  return tasks;
}

function normalizeScopePath(value: string | null): string {
  return value ?? ".";
}

function filterPathsWithinScope(paths: string[], scopePath: string): string[] {
  if (scopePath === ".") {
    return uniqueStrings(paths).sort();
  }
  return uniqueStrings(paths.filter((path) => pathWithinRoots(path, [scopePath]))).sort();
}

async function getBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => ({}));
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

export async function GET(request: Request) {
  try {
    const claims = await requireUserSession(request);
    const url = new URL(request.url);
    const vaultRoot = await createVault(claims.tenantId);
    const requestedPath = normalizeScopePath(url.searchParams.get("path"));
    const requestedFileId = asString(url.searchParams.get("file_id"));
    const scopePath = requestedFileId ? await resolvePathForFileId(vaultRoot, requestedFileId) : requestedPath;

    if (!pathWithinRoots(scopePath, claims.readRoots)) {
      throw new BackendError(`Read is restricted outside the token's allowed folders: ${scopePath}`, 403);
    }

    const lockedPaths = await getLockedPaths(vaultRoot);
    const visibleLocks = filterPathsWithinScope(
      lockedPaths.filter((path) => pathWithinRoots(path, claims.readRoots)),
      scopePath
    );

    return NextResponse.json({
      tenant_id: claims.tenantId,
      scope_path: scopePath,
      count: visibleLocks.length,
      locked_paths: visibleLocks,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const claims = await requireUserSession(request);
    const body = await getBody(request);
    const vaultRoot = await createVault(claims.tenantId);
    const paths = uniqueStrings((await Promise.all(collectPaths(vaultRoot, body))).flat()).filter(Boolean);
    if (!paths.length) {
      throw new BackendError("Missing path or file_id", 400);
    }

    const results = [];
    for (const targetPath of paths) {
      if (!pathWithinRoots(targetPath, claims.writeRoots)) {
        throw new BackendError(`Write is restricted outside the token's allowed folders: ${targetPath}`, 403);
      }
      const changed = await lockPath(vaultRoot, targetPath);
      results.push({ path: targetPath, locked: true, changed });
    }

    const lockedPaths = filterPathsWithinScope(
      (await getLockedPaths(vaultRoot)).filter((path) => pathWithinRoots(path, claims.readRoots)),
      "."
    );
    return NextResponse.json({
      tenant_id: claims.tenantId,
      action: "lock",
      count: results.length,
      changed: results.filter((item) => item.changed).length,
      results,
      locked_paths: lockedPaths,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const claims = await requireUserSession(request);
    const body = await getBody(request);
    const vaultRoot = await createVault(claims.tenantId);
    const paths = uniqueStrings((await Promise.all(collectPaths(vaultRoot, body))).flat()).filter(Boolean);
    if (!paths.length) {
      throw new BackendError("Missing path or file_id", 400);
    }

    const results = [];
    for (const targetPath of paths) {
      if (!pathWithinRoots(targetPath, claims.writeRoots)) {
        throw new BackendError(`Write is restricted outside the token's allowed folders: ${targetPath}`, 403);
      }
      const changed = await unlockPath(vaultRoot, targetPath);
      results.push({ path: targetPath, locked: false, changed });
    }

    const lockedPaths = filterPathsWithinScope(
      (await getLockedPaths(vaultRoot)).filter((path) => pathWithinRoots(path, claims.readRoots)),
      "."
    );
    return NextResponse.json({
      tenant_id: claims.tenantId,
      action: "unlock",
      count: results.length,
      changed: results.filter((item) => item.changed).length,
      results,
      locked_paths: lockedPaths,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
