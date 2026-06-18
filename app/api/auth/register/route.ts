import { NextResponse } from "next/server";
import { BackendError } from "../../../lib/backend";
import { registerUser, sessionCookie } from "../../../lib/user_auth";

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
    const result = await registerUser({
      email: String(body?.email ?? "").trim(),
      password: String(body?.password ?? ""),
      name: body?.name ? String(body.name) : undefined,
      role: body?.role === "admin" ? "admin" : undefined,
    });

    const response = NextResponse.json({ user: result.user });
    response.headers.set("Set-Cookie", sessionCookie(result.sessionToken));
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
