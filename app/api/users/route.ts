import { NextResponse } from "next/server";
import { API_VERSION } from "../../lib/api_contract";
import { BackendError } from "../../lib/backend";
import { getUserById, listUsers, registerUser, requireUserSession } from "../../lib/user_auth";
import { parseJsonObject, validateUserCreateBody } from "../../lib/api_validation";

export const runtime = "nodejs";

function errorResponse(error: unknown): NextResponse {
	if (error instanceof BackendError) {
		return NextResponse.json({ error: error.message }, { status: error.status });
	}
	const message = error instanceof Error ? error.message : "Unexpected error";
	return NextResponse.json({ error: message }, { status: 500 });
}

function requireAdmin(role: string): void {
	if (role !== "admin") {
		throw new BackendError("Admin privileges required", 403);
	}
}

export async function GET(request: Request) {
	try {
		const session = await requireUserSession(request);
		requireAdmin(session.role);
		return NextResponse.json({
			api_version: API_VERSION,
			users: await listUsers(),
		});
	} catch (error) {
		return errorResponse(error);
	}
}

export async function POST(request: Request) {
	try {
		const session = await requireUserSession(request);
		requireAdmin(session.role);
		const body = validateUserCreateBody(parseJsonObject(await request.json().catch(() => ({}))));
		const result = await registerUser({
			email: body.email,
			password: body.password,
			name: body.name,
			role: body.role,
		});
		const created = await getUserById(result.user.id);
		return NextResponse.json({
			api_version: API_VERSION,
			user: created ?? result.user,
		});
	} catch (error) {
		return errorResponse(error);
	}
}
