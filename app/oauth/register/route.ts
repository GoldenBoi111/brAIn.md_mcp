import { NextResponse } from "next/server";
import { BackendError } from "../../lib/errors";
import { registerOAuthClient } from "../../lib/claude_oauth";
import { getPublicOrigin } from "../../lib/public_origin";

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
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const client = await registerOAuthClient({
      client_name: typeof body.client_name === "string"
        ? body.client_name
        : typeof body.clientName === "string"
          ? body.clientName
          : undefined,
      redirect_uris: Array.isArray(body.redirect_uris)
        ? body.redirect_uris.map((value) => String(value))
        : Array.isArray(body.redirectUris)
          ? body.redirectUris.map((value) => String(value))
          : [],
      token_endpoint_auth_method: body.token_endpoint_auth_method === "none"
        ? "none"
        : body.token_endpoint_auth_method === "client_secret_post"
          ? "client_secret_post"
          : body.token_endpoint_auth_method === "client_secret_basic"
            ? "client_secret_basic"
        : undefined,
    });
    const origin = getPublicOrigin(request);
    const registrationClientUri = `${origin}/oauth/register/${client.client_id}`;
    return NextResponse.json({
      client_id: client.client_id,
      client_secret: client.client_secret ?? "",
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      scope: "mcp",
      grant_types: client.grant_types,
      response_types: client.response_types,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      client_id_issued_at: client.created_at,
      client_secret_expires_at: 0,
      registration_client_uri: registrationClientUri,
    }, {
      status: 201,
      headers: {
        Location: registrationClientUri,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
