import { NextResponse } from "next/server";
import { clearSessionCookie } from "../../../lib/user_auth";

export const runtime = "nodejs";

export async function POST() {
  const response = NextResponse.json({ logged_out: true });
  response.headers.set("Set-Cookie", clearSessionCookie());
  return response;
}
