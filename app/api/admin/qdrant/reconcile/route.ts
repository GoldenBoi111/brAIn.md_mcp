import { NextResponse } from "next/server";
import { API_VERSION } from "../../../../lib/api_contract";
import { BackendError } from "../../../../lib/backend";
import { parseJsonObject, validateQdrantReconcileBody } from "../../../../lib/api_validation";
import { reconcileAllUsersQdrantIndex, reconcileTenantByUserId, reconcileTenantQdrantIndex } from "../../../../lib/qdrant_reconcile";
import { requireUserSession } from "../../../../lib/user_auth";

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

export async function POST(request: Request) {
	try {
		const session = await requireUserSession(request);
		requireAdmin(session.role);
		const body = validateQdrantReconcileBody(parseJsonObject(await request.json().catch(() => ({}))));

		let result;
		if (body.userId) {
			result = await reconcileTenantByUserId(body.userId, {
				path: body.path,
				embeddingModel: body.embeddingModel,
				repairMissing: body.repairMissing,
			});
		} else if (body.tenantId) {
			result = await reconcileTenantQdrantIndex(body.tenantId, {
				path: body.path,
				embeddingModel: body.embeddingModel,
				repairMissing: body.repairMissing,
			});
		} else {
			result = await reconcileAllUsersQdrantIndex({
				path: body.path,
				embeddingModel: body.embeddingModel,
				repairMissing: body.repairMissing,
			});
		}

		return NextResponse.json({
			api_version: API_VERSION,
			scope: body.userId ? "user" : body.tenantId ? "tenant" : "all",
			repair_missing: body.repairMissing,
			...result,
		});
	} catch (error) {
		return errorResponse(error);
	}
}

export async function GET() {
	return NextResponse.json({
		route: "/api/admin/qdrant/reconcile",
		method: "POST",
		auth: "admin-session",
		body: {
			userId: "string",
			tenantId: "string",
			path: ".",
			embeddingModel: "jasper-token-compression-600m",
			repairMissing: true,
		},
	});
}
