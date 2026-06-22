import { NextResponse } from "next/server";
import {
	BackendError,
	createVault,
	getPathForFileId,
	getPathForFolderId,
	getTokenLockedPaths,
	lockTokenPath,
	loadTokenLockRecord,
	pathWithinRoots,
	unlockTokenPath,
} from "../../../../../lib/backend";
import { requireUserSession } from "../../../../../lib/user_auth";

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

async function resolvePathForFolderId(vaultRoot: string, folderId: string): Promise<string> {
	const relativePath = await getPathForFolderId(vaultRoot, folderId);
	if (!relativePath) {
		throw new BackendError(`Unknown folder_id: ${folderId}`, 404);
	}
	return relativePath;
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
		tasks.push(resolvePathForFileId(vaultRoot, directFileId).then((value) => [value]));
	}

	const directFolderId = asString(body.folder_id);
	if (directFolderId) {
		tasks.push(resolvePathForFolderId(vaultRoot, directFolderId).then((value) => [value]));
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
					const folderId = typeof value === "object" && value !== null ? asString((value as Record<string, unknown>).folder_id) : null;
					if (folderId) {
						return resolvePathForFolderId(vaultRoot, folderId);
					}
					throw new BackendError("Each lock target must be a path, file_id, or folder_id", 400);
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

	const folderIds = Array.isArray(body.folder_ids) ? body.folder_ids : [];
	if (folderIds.length) {
		tasks.push(
			Promise.all(
				folderIds.map(async (value) => {
					const folderId = asString(value);
					if (!folderId) {
						throw new BackendError("Each folder_id must be a non-empty string", 400);
					}
					return resolvePathForFolderId(vaultRoot, folderId);
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

async function requireTokenRecord(sessionTenantId: string, tokenId: string) {
	const record = await loadTokenLockRecord(tokenId);
	if (!record) {
		throw new BackendError(`Unknown token lock record: ${tokenId}`, 404);
	}
	if (record.tenant_id !== sessionTenantId) {
		throw new BackendError("Token does not belong to the current tenant", 403);
	}
	return record;
}

export async function GET(request: Request, context: { params: Promise<{ tokenId: string }> | { tokenId: string } }) {
	try {
		const claims = await requireUserSession(request);
		const params = await Promise.resolve(context.params);
		const tokenId = String(params.tokenId ?? "").trim();
		if (!tokenId) {
			throw new BackendError("Missing tokenId", 400);
		}
		const vaultRoot = await createVault(claims.tenantId);
		const record = await requireTokenRecord(claims.tenantId, tokenId);
		const url = new URL(request.url);
		const requestedPath = normalizeScopePath(url.searchParams.get("path"));
		const requestedFileId = asString(url.searchParams.get("file_id"));
		const requestedFolderId = asString(url.searchParams.get("folder_id"));
		const scopePath = requestedFileId ? await resolvePathForFileId(vaultRoot, requestedFileId) : requestedFolderId ? await resolvePathForFolderId(vaultRoot, requestedFolderId) : requestedPath;

		if (!pathWithinRoots(scopePath, claims.readRoots)) {
			throw new BackendError(`Read is restricted outside the token's allowed folders: ${scopePath}`, 403);
		}

		const lockedPaths = await getTokenLockedPaths(tokenId);
		const visibleLocks = filterPathsWithinScope(lockedPaths.filter((path) => pathWithinRoots(path, claims.readRoots)), scopePath);

		return NextResponse.json({
			token_id: tokenId,
			tenant_id: record.tenant_id,
			token_name: record.token_name,
			subject: record.subject,
			scopes: record.scopes,
			scope_path: scopePath,
			count: visibleLocks.length,
			locked_paths: visibleLocks,
		});
	} catch (error) {
		return errorResponse(error);
	}
}

export async function POST(request: Request, context: { params: Promise<{ tokenId: string }> | { tokenId: string } }) {
	try {
		const claims = await requireUserSession(request);
		const params = await Promise.resolve(context.params);
		const tokenId = String(params.tokenId ?? "").trim();
		if (!tokenId) {
			throw new BackendError("Missing tokenId", 400);
		}
		const body = await getBody(request);
		const vaultRoot = await createVault(claims.tenantId);
		await requireTokenRecord(claims.tenantId, tokenId);
		const paths = uniqueStrings((await Promise.all(collectPaths(vaultRoot, body))).flat()).filter(Boolean);
		if (!paths.length) {
			throw new BackendError("Missing path or file_id", 400);
		}

		const results = [];
		for (const targetPath of paths) {
			if (!pathWithinRoots(targetPath, claims.writeRoots)) {
				throw new BackendError(`Write is restricted outside the token's allowed folders: ${targetPath}`, 403);
			}
			const changed = await lockTokenPath(tokenId, targetPath);
			results.push({ path: targetPath, locked: true, changed });
		}

		const lockedPaths = filterPathsWithinScope(await getTokenLockedPaths(tokenId), ".");
		return NextResponse.json({
			token_id: tokenId,
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

export async function DELETE(request: Request, context: { params: Promise<{ tokenId: string }> | { tokenId: string } }) {
	try {
		const claims = await requireUserSession(request);
		const params = await Promise.resolve(context.params);
		const tokenId = String(params.tokenId ?? "").trim();
		if (!tokenId) {
			throw new BackendError("Missing tokenId", 400);
		}
		const body = await getBody(request);
		const vaultRoot = await createVault(claims.tenantId);
		await requireTokenRecord(claims.tenantId, tokenId);
		const paths = uniqueStrings((await Promise.all(collectPaths(vaultRoot, body))).flat()).filter(Boolean);
		if (!paths.length) {
			throw new BackendError("Missing path or file_id", 400);
		}

		const results = [];
		for (const targetPath of paths) {
			if (!pathWithinRoots(targetPath, claims.writeRoots)) {
				throw new BackendError(`Write is restricted outside the token's allowed folders: ${targetPath}`, 403);
			}
			const changed = await unlockTokenPath(tokenId, targetPath);
			results.push({ path: targetPath, locked: false, changed });
		}

		const lockedPaths = filterPathsWithinScope(await getTokenLockedPaths(tokenId), ".");
		return NextResponse.json({
			token_id: tokenId,
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
