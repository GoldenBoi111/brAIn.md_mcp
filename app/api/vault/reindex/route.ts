import { NextResponse } from "next/server";
import { API_VERSION } from "../../../lib/api_contract";
import {
	BackendError,
	createVault,
	getFileIdForPath,
	listPathsUnderPath,
	loadLockSet,
	pathWithinRoots,
	qdrantUpdateFile,
	readFile,
} from "../../../lib/backend";
import { requireUserSession } from "../../../lib/user_auth";
import { parseJsonObject, validateReindexBody } from "../../../lib/api_validation";

export const runtime = "nodejs";

function errorResponse(error: unknown): NextResponse {
	if (error instanceof BackendError) {
		return NextResponse.json({ error: error.message }, { status: error.status });
	}
	const message = error instanceof Error ? error.message : "Unexpected error";
	return NextResponse.json({ error: message }, { status: 500 });
}

export async function POST(request: Request) {
	try {
		const claims = await requireUserSession(request);
		const body = validateReindexBody(parseJsonObject(await request.json().catch(() => ({}))));
		const vaultRoot = await createVault(claims.tenantId);
		if (!pathWithinRoots(body.path, claims.writeRoots)) {
			throw new BackendError(`Write is restricted outside the token's allowed folders: ${body.path}`, 403);
		}
		const paths = await listPathsUnderPath(vaultRoot, body.path);
		const locks = await loadLockSet(vaultRoot);
		const results: Array<{ path: string; file_id: string; updated_chunks: number }> = [];
		let skipped = 0;
		for (const relativePath of paths) {
			if (!pathWithinRoots(relativePath, claims.writeRoots)) {
				continue;
			}
			const fileId = await getFileIdForPath(vaultRoot, relativePath);
			if (!fileId) {
				continue;
			}
			try {
				const content = await readFile(vaultRoot, locks, relativePath);
				const result = await qdrantUpdateFile({
					tenantId: claims.tenantId,
					fileId,
					content,
					embeddingModel: body.embeddingModel,
				});
				results.push({ path: relativePath, file_id: fileId, updated_chunks: result.created_or_updated_chunks });
			} catch {
				skipped += 1;
			}
		}

		return NextResponse.json({
			api_version: API_VERSION,
			tenant_id: claims.tenantId,
			path: body.path,
			count: results.length,
			skipped,
			results,
		});
	} catch (error) {
		return errorResponse(error);
	}
}
