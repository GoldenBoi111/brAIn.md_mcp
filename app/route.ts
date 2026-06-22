import { NextResponse } from "next/server";
import { getPublicOrigin } from "./lib/public_origin";

export const runtime = "nodejs";

export function GET(request: Request) {
  return NextResponse.redirect(new URL("/mcp", getPublicOrigin(request)), 307);
}

export function POST(request: Request) {
  return NextResponse.redirect(new URL("/mcp", getPublicOrigin(request)), 307);
}
