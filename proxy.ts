import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;
	if (!pathname.startsWith("/api/v1")) {
		return NextResponse.next();
	}

	const rewritten = request.nextUrl.clone();
	rewritten.pathname = pathname.replace(/^\/api\/v1/, "/api");
	return NextResponse.rewrite(rewritten);
}

export const config = {
	matcher: ["/api/v1", "/api/v1/:path*"],
};

