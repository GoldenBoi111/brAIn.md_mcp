import { NextResponse } from "next/server";
import { BackendError, issueToken } from "../../../lib/backend";
import { requireUserSession } from "../../../lib/user_auth";

export const runtime = "nodejs";

function errorResponse(error: unknown): NextResponse {
  if (error instanceof BackendError) {
    const backendError = error as BackendError;
    return NextResponse.json({ error: backendError.message }, { status: backendError.status });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function POST(request: Request) {
  try {
    const session = await requireUserSession(request);
    const body: any = await request.json().catch(() => ({}));
    const tokenName = String(body?.tokenName ?? body?.token_name ?? "default").trim();
    const subject = String(body?.subject ?? session.userId ?? "").trim();
    const scopes = Array.isArray(body?.scopes) && body.scopes.length ? body.scopes.map((value: unknown) => String(value)) : ["mcp"];

    const token = await issueToken({
      tenantId: session.tenantId,
      tokenName,
      subject: subject || session.userId,
      scopes,
      readRoots: Array.isArray(body?.readRoots) ? body.readRoots.map((value: unknown) => String(value)) : undefined,
      writeRoots: Array.isArray(body?.writeRoots) ? body.writeRoots.map((value: unknown) => String(value)) : undefined,
      ttlDays: Number.isFinite(Number(body?.ttlDays)) ? Number(body.ttlDays) : undefined,
      issuer: body?.issuer ? String(body.issuer) : undefined,
      audience: body?.audience ? String(body.audience) : undefined,
    });

    return NextResponse.json({ token });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET() {
  return NextResponse.json({
    route: "/api/mcp/token",
    method: "POST",
    auth: "required",
    body: {
      tokenName: "string",
      subject: "string",
      scopes: ["mcp"],
      readRoots: ["folder"],
      writeRoots: ["folder"],
      ttlDays: 365,
    },
  });
}
