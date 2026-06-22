import { NextResponse } from "next/server";
import {
  BackendError,
  deleteTokenLockRecord,
  listTokenLockRecords,
  revokeTokenLockRecord,
  updateTokenLockRecord,
} from "../../../lib/backend";
import { API_VERSION } from "../../../lib/api_contract";
import { requireUserSession } from "../../../lib/user_auth";
import { parseJsonObject, validateTokenUpdateBody } from "../../../lib/api_validation";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ tokenId: string }>;
};

function errorResponse(error: unknown): NextResponse {
  if (error instanceof BackendError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return NextResponse.json({ error: message }, { status: 500 });
}

async function requireTenantToken(tokenId: string, tenantId: string) {
  const token = (await listTokenLockRecords()).find((record) => record.token_id === tokenId && record.tenant_id === tenantId);
  if (!token) {
    throw new BackendError(`Unknown token: ${tokenId}`, 404);
  }
  return token;
}

export async function GET(request: Request, { params }: Params) {
  try {
    const claims = await requireUserSession(request);
    const { tokenId } = await params;
    const token = await requireTenantToken(String(tokenId ?? "").trim(), claims.tenantId);
    return NextResponse.json({ api_version: API_VERSION, tenant_id: claims.tenantId, token });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const claims = await requireUserSession(request);
    const { tokenId } = await params;
    const token = await requireTenantToken(String(tokenId ?? "").trim(), claims.tenantId);
    const body = validateTokenUpdateBody(parseJsonObject(await request.json().catch(() => ({}))));
    if (body.revoked === true) {
      const revoked = await revokeTokenLockRecord(token.token_id, "revoked by admin");
      return NextResponse.json({ api_version: API_VERSION, tenant_id: claims.tenantId, token: { token_id: token.token_id, ...revoked } });
    }
    const patched = await updateTokenLockRecord(token.token_id, {
      token_name: body.tokenName,
      provider_name: body.providerName,
      description: body.description,
      avatar_url: body.avatarUrl,
      avatar_alt: body.avatarAlt,
      avatar_background: body.avatarBackground,
    });
    return NextResponse.json({ api_version: API_VERSION, tenant_id: claims.tenantId, token: { token_id: token.token_id, ...patched } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const claims = await requireUserSession(request);
    const { tokenId } = await params;
    const token = await requireTenantToken(String(tokenId ?? "").trim(), claims.tenantId);
    await deleteTokenLockRecord(token.token_id);
    return NextResponse.json({ api_version: API_VERSION, tenant_id: claims.tenantId, deleted: true, token_id: token.token_id });
  } catch (error) {
    return errorResponse(error);
  }
}
