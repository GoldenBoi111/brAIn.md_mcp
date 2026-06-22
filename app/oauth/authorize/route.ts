import { NextResponse } from "next/server";
import { BackendError } from "../../lib/errors";
import { buildAuthorizeRedirect, createAuthorizationCode, getOAuthClient, htmlAuthorizePage, normalizeOAuthScope } from "../../lib/claude_oauth";
import { getPublicOrigin } from "../../lib/public_origin";
import { requireUserSession } from "../../lib/user_auth";

export const runtime = "nodejs";

function errorResponse(error: unknown): NextResponse {
  if (error instanceof BackendError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return NextResponse.json({ error: message }, { status: 500 });
}

function parseQuery(request: Request): {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  scope: string[];
  state: string | null;
  code_challenge: string | null;
  code_challenge_method: "S256" | "plain" | null;
  token_name: string;
  provider_name: string;
  description: string;
  avatar_url: string;
  avatar_alt: string;
  avatar_background: string;
} {
  const url = new URL(request.url);
  return {
    client_id: String(url.searchParams.get("client_id") ?? "").trim(),
    redirect_uri: String(url.searchParams.get("redirect_uri") ?? "").trim(),
    response_type: String(url.searchParams.get("response_type") ?? "code").trim(),
    scope: normalizeOAuthScope(url.searchParams.get("scope")),
    state: url.searchParams.get("state"),
    code_challenge: url.searchParams.get("code_challenge"),
    code_challenge_method: url.searchParams.get("code_challenge_method") === "S256"
      ? "S256"
      : url.searchParams.get("code_challenge_method") === "plain"
        ? "plain"
        : null,
    token_name: String(url.searchParams.get("token_name") ?? "claude-web").trim() || "claude-web",
    provider_name: String(url.searchParams.get("provider_name") ?? "Claude").trim() || "Claude",
    description: String(url.searchParams.get("description") ?? "").trim(),
    avatar_url: String(url.searchParams.get("avatar_url") ?? "").trim(),
    avatar_alt: String(url.searchParams.get("avatar_alt") ?? "").trim(),
    avatar_background: String(url.searchParams.get("avatar_background") ?? "").trim(),
  };
}

export async function GET(request: Request) {
  const query = parseQuery(request);
  const publicOrigin = getPublicOrigin(request);
  try {
    if (!query.client_id) {
      throw new BackendError("Missing client_id", 400);
    }
    const client = await getOAuthClient(query.client_id);
    if (!client) {
      throw new BackendError("Unknown OAuth client", 400);
    }
    const redirectUri = query.redirect_uri || client.redirect_uris[0] || "";
    if (!redirectUri) {
      throw new BackendError("Missing redirect_uri", 400);
    }
    const session = await requireUserSession(request);
    const code = await createAuthorizationCode({
      ...query,
      redirect_uri: redirectUri,
      session,
    });
    return NextResponse.redirect(buildAuthorizeRedirect(redirectUri, code, query.state), 302);
  } catch (error) {
    if (error instanceof BackendError && error.status === 401) {
      const client = query.client_id ? await getOAuthClient(query.client_id).catch(() => null) : null;
      const authorizeUrl = new URL("/oauth/authorize", publicOrigin);
      for (const [key, value] of new URL(request.url).searchParams.entries()) {
        authorizeUrl.searchParams.set(key, value);
      }
      return new NextResponse(
        htmlAuthorizePage({
          authorizeUrl: authorizeUrl.toString(),
          clientName: client?.client_name ?? "Claude",
          redirectUri: query.redirect_uri || client?.redirect_uris[0] || "",
          scope: query.scope,
          tokenName: query.token_name,
          providerName: query.provider_name,
          description: query.description,
          avatarUrl: query.avatar_url,
          avatarAlt: query.avatar_alt,
          avatarBackground: query.avatar_background,
        }),
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    return errorResponse(error);
  }
}
