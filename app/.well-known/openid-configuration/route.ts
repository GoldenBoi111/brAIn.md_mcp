import { NextResponse } from "next/server";
import { getPublicOrigin } from "../../lib/public_origin";

export const runtime = "nodejs";

export function GET(request: Request) {
  const origin = getPublicOrigin(request);
  return NextResponse.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    userinfo_endpoint: `${origin}/oauth/userinfo`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    claims_supported: ["sub", "email", "name", "tenant_id"],
    scopes_supported: ["openid", "email", "profile", "mcp"],
  });
}
