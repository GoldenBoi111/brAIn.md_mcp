import { NextResponse } from "next/server";
import { oauthAuthorizationServerMetadata } from "../../lib/claude_oauth";
import { getPublicOrigin } from "../../lib/public_origin";

export const runtime = "nodejs";

export function GET(request: Request) {
  return NextResponse.json(oauthAuthorizationServerMetadata(getPublicOrigin(request)));
}
