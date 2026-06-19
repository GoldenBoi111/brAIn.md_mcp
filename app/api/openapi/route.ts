import { NextResponse } from "next/server";
import { buildOpenApiSpec } from "../../lib/api_contract";

export const runtime = "nodejs";

export function GET() {
	return NextResponse.json(buildOpenApiSpec());
}
