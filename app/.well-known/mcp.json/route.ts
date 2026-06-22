import { NextResponse } from "next/server";
import { getPublicOrigin } from "../../lib/public_origin";

export const runtime = "nodejs";

export function GET(request: Request) {
  const origin = getPublicOrigin(request);
  return NextResponse.json({
    name: "brAIn.md MCP Server",
    version: "0.1.0",
    transport: "http",
    mcp_endpoint: `${origin}/mcp`,
    authorization_server: `${origin}/.well-known/oauth-authorization-server`,
  });
}
