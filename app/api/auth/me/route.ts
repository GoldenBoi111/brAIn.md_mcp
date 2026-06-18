import { NextResponse } from "next/server";
import { BackendError } from "../../../lib/backend";
import { requireUserSession } from "../../../lib/user_auth";

export const runtime = "nodejs";

function errorResponse(error: unknown): NextResponse {
  if (error instanceof BackendError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const session = await requireUserSession(request);
    return NextResponse.json({ user: session });
  } catch (error) {
    return errorResponse(error);
  }
}
