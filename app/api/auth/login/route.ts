import { NextResponse } from "next/server";
import { BackendError } from "../../../lib/backend";
import { loginUser, sessionCookie } from "../../../lib/user_auth";

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
    const body: any = await request.json().catch(() => ({}));
    const email = String(body?.email ?? "").trim();
    const password = String(body?.password ?? "");
    const result = await loginUser({ email, password });

    const response = NextResponse.json({ user: result.user });
    response.headers.set("Set-Cookie", sessionCookie(result.sessionToken));
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
