import { NextResponse } from "next/server";
import { getPublicOrigin } from "../../../lib/public_origin";

export const runtime = "nodejs";

export function GET(request: Request) {
  const origin = getPublicOrigin(request);
  const resourcePath = new URL(request.url).pathname.replace(/^\/\.well-known\/oauth-protected-resource\/?/, "");
  const resource = resourcePath ? `${origin}/${resourcePath}` : `${origin}/mcp`;
  return NextResponse.json({
    resource,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
  });
}
