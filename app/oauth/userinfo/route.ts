import { NextResponse } from "next/server";
import { BackendError, verifyToken } from "../../lib/backend";

export const runtime = "nodejs";

function errorResponse(error: unknown): NextResponse {
  if (error instanceof BackendError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return NextResponse.json({ error: message }, { status: 500 });
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length).trim() || null;
}

export async function GET(request: Request) {
  try {
    const token = bearerToken(request);
    if (!token) {
      throw new BackendError("Missing bearer token", 401);
    }
    const claims = await verifyToken(token);
    return NextResponse.json({
      sub: claims.subject,
      email: claims.email || undefined,
      name: claims.tokenName,
      tenant_id: claims.tenantId,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
