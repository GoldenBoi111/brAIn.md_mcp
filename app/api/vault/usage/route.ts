import { NextResponse } from "next/server";
import { API_VERSION } from "../../../lib/api_contract";
import { BackendError, createVault, getVaultUsageBytes } from "../../../lib/backend";
import { requireUserSession } from "../../../lib/user_auth";
import { validateVaultUsageQuery } from "../../../lib/api_validation";

export const runtime = "nodejs";

function errorResponse(error: unknown): NextResponse {
	if (error instanceof BackendError) {
		return NextResponse.json({ error: error.message }, { status: error.status });
	}
	const message = error instanceof Error ? error.message : "Unexpected error";
	return NextResponse.json({ error: message }, { status: 500 });
}

export async function GET(request: Request) {
	try {
		const claims = await requireUserSession(request);
		const query = validateVaultUsageQuery(new URL(request.url));
		const vaultRoot = await createVault(claims.tenantId);
		const usageBytes = await getVaultUsageBytes(vaultRoot);
		return NextResponse.json({
			api_version: API_VERSION,
			tenant_id: claims.tenantId,
			path: query.path,
			view: query.view,
			usage_bytes: usageBytes,
			max_bytes: 100 * 1024 * 1024,
		});
	} catch (error) {
		return errorResponse(error);
	}
}
