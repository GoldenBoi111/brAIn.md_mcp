import { NextResponse } from "next/server";
import { API_VERSION } from "../lib/api_contract";

export const runtime = "nodejs";

export function GET() {
	return NextResponse.json({
		name: "brAIn.md MCP Server API",
		api_version: API_VERSION,
		versioned_root: `/api/${API_VERSION}`,
		routes: [
			"/health",
			"/vault/locks",
			"/vault/usage",
			"/vault/reindex",
			"/tokens",
			"/users",
			"/openapi",
		],
	});
}

