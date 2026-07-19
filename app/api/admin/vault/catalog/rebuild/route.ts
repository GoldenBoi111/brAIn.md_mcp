import { NextResponse } from "next/server";
import { API_VERSION } from "../../../../../lib/api_contract";
import { BackendError, createVault, rebuildCatalogFromFilesystem, type CatalogRebuildResult } from "../../../../../lib/backend";
import { parseJsonObject, validateVaultCatalogRebuildBody } from "../../../../../lib/api_validation";
import { listUsers, requireUserSession } from "../../../../../lib/user_auth";

export const runtime = "nodejs";

function errorResponse(error: unknown): NextResponse {
	if (error instanceof BackendError) {
		return NextResponse.json({ error: error.message }, { status: error.status });
	}
	const message = error instanceof Error ? error.message : "Unexpected error";
	return NextResponse.json({ error: message }, { status: 500 });
}

function requireAdmin(role: string): void {
	if (role !== "admin") {
		throw new BackendError("Admin privileges required", 403);
	}
}

async function rebuildTenant(tenantId: string) {
	const vaultRoot = await createVault(tenantId);
	return rebuildCatalogFromFilesystem(vaultRoot);
}

export async function POST(request: Request) {
	try {
		const session = await requireUserSession(request);
		requireAdmin(session.role);
		const body = validateVaultCatalogRebuildBody(parseJsonObject(await request.json().catch(() => ({}))));

		if (body.userId) {
			const users = await listUsers();
			const user = users.find((entry) => entry.id === body.userId);
			if (!user) {
				throw new BackendError(`Unknown user: ${body.userId}`, 404);
			}
			const result = await rebuildTenant(user.tenantId);
			return NextResponse.json({ api_version: API_VERSION, scope: "user", ...result });
		}

		if (body.tenantId) {
			const result = await rebuildTenant(body.tenantId);
			return NextResponse.json({ api_version: API_VERSION, scope: "tenant", ...result });
		}

		const users = await listUsers();
		const results: CatalogRebuildResult[] = [];
		let filesScanned = 0;
		let foldersScanned = 0;
		let filesReused = 0;
		let filesCreated = 0;
		let foldersReused = 0;
		let foldersCreated = 0;
		let filesRemoved = 0;
		let foldersRemoved = 0;

		for (const user of users) {
			const result = await rebuildTenant(user.tenantId);
			results.push(result);
			filesScanned += result.files_scanned;
			foldersScanned += result.folders_scanned;
			filesReused += result.files_reused;
			filesCreated += result.files_created;
			foldersReused += result.folders_reused;
			foldersCreated += result.folders_created;
			filesRemoved += result.files_removed;
			foldersRemoved += result.folders_removed;
		}

		return NextResponse.json({
			api_version: API_VERSION,
			scope: "all",
			inspected_tenants: users.length,
			files_scanned: filesScanned,
			folders_scanned: foldersScanned,
			files_reused: filesReused,
			files_created: filesCreated,
			folders_reused: foldersReused,
			folders_created: foldersCreated,
			files_removed: filesRemoved,
			folders_removed: foldersRemoved,
			results,
		});
	} catch (error) {
		return errorResponse(error);
	}
}

export async function GET() {
	return NextResponse.json({
		route: "/api/admin/vault/catalog/rebuild",
		method: "POST",
		auth: "admin-session",
		body: {
			tenantId: "tenant-id",
			userId: "user-id",
		},
		note: "Rebuilds .vault-index.json from the on-disk vault contents and drops stale catalog entries.",
	});
}
