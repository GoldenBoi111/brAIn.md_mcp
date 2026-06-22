import { NextResponse } from "next/server";
import { API_VERSION } from "../../lib/api_contract";
import { BackendError, issueToken, listTokenLockRecords, verifyToken } from "../../lib/backend";
import { requireUserSession } from "../../lib/user_auth";
import { parseJsonObject, validateTokenCreateBody } from "../../lib/api_validation";

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
		const tokens = (await listTokenLockRecords()).filter((record) => record.tenant_id === claims.tenantId);
		return NextResponse.json({
			api_version: API_VERSION,
			tenant_id: claims.tenantId,
			count: tokens.length,
			tokens,
		});
	} catch (error) {
		return errorResponse(error);
	}
}

export async function POST(request: Request) {
	try {
		const claims = await requireUserSession(request);
		const body = validateTokenCreateBody(parseJsonObject(await request.json().catch(() => ({}))));
		const token = await issueToken({
			tenantId: claims.tenantId,
			tokenName: body.tokenName,
			subject: body.subject,
			scopes: body.scopes,
			readRoots: body.readRoots,
			writeRoots: body.writeRoots,
			ttlDays: body.ttlDays,
			issuer: body.issuer,
			audience: body.audience,
			providerName: body.providerName,
			description: body.description,
			avatarUrl: body.avatarUrl,
			avatarAlt: body.avatarAlt,
			avatarBackground: body.avatarBackground,
		});
		const tokenClaims = await verifyToken(token);
		return NextResponse.json({
			api_version: API_VERSION,
			tenant_id: tokenClaims.tenantId,
			token_id: tokenClaims.jwtId,
			token_name: tokenClaims.tokenName,
			token,
		});
	} catch (error) {
		return errorResponse(error);
	}
}
