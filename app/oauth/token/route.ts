import { NextResponse } from "next/server";
import { BackendError } from "../../lib/errors";
import { consumeAuthorizationCode, mintOAuthAccessToken, parseBasicAuth, parseTokenRequestBody } from "../../lib/claude_oauth";

export const runtime = "nodejs";

function errorResponse(error: unknown): NextResponse {
  if (error instanceof BackendError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return NextResponse.json({ error: message }, { status: 500 });
}

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await request.json().catch(() => ({}))) as Record<string, unknown>;
  }
  const form = await request.formData().catch(() => new FormData());
  return Object.fromEntries(form.entries());
}

export async function POST(request: Request) {
  try {
    const body = await parseBody(request);
    const basic = parseBasicAuth(request.headers.get("authorization") ?? request.headers.get("Authorization"));
    const parsed = parseTokenRequestBody({
      ...body,
      client_id: String(body.client_id ?? basic?.client_id ?? "").trim(),
      client_secret: typeof body.client_secret === "string" ? body.client_secret : basic?.client_secret ?? null,
    });
    const { session, scope, tokenName, providerName, description, avatarUrl, avatarAlt, avatarBackground, clientId, clientName } = await consumeAuthorizationCode(parsed);
    return NextResponse.json(
      await mintOAuthAccessToken({
        session,
        scope,
        tokenName,
        providerName,
        description,
        avatarUrl,
        avatarAlt,
        avatarBackground,
        oauthClientId: clientId,
        oauthClientName: clientName,
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
