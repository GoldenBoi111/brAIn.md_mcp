import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const DEFAULT_ALLOWED_HEADERS = [
	"Content-Type",
	"Authorization",
	"X-Requested-With",
	"X-CSRF-Token",
	"Accept",
	"Origin",
].join(", ");

function setCorsHeaders(response: NextResponse, origin: string | null, requestHeaders: string | null) {
	if (origin) {
		response.headers.set("Access-Control-Allow-Origin", origin);
		response.headers.append("Vary", "Origin");
	}
	response.headers.set("Access-Control-Allow-Credentials", "true");
	response.headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
	response.headers.set("Access-Control-Allow-Headers", requestHeaders ?? DEFAULT_ALLOWED_HEADERS);
	response.headers.set("Access-Control-Max-Age", "86400");
}

export function proxy(request: NextRequest) {
	const origin = request.headers.get("origin");
	const requestHeaders = request.headers.get("access-control-request-headers");
	const { pathname } = request.nextUrl;

	if (request.method === "OPTIONS") {
		const response = new NextResponse(null, { status: 204 });
		setCorsHeaders(response, origin, requestHeaders);
		return response;
	}

	if (!pathname.startsWith("/api/v1")) {
		const response = NextResponse.next();
		setCorsHeaders(response, origin, requestHeaders);
		return response;
	}

	const rewritten = request.nextUrl.clone();
	rewritten.pathname = pathname.replace(/^\/api\/v1/, "/api");
	const response = NextResponse.rewrite(rewritten);
	setCorsHeaders(response, origin, requestHeaders);
	return response;
}

export const config = {
	matcher: ["/api/:path*", "/oauth/:path*", "/.well-known/:path*", "/mcp", "/api/v1/:path*"],
};
