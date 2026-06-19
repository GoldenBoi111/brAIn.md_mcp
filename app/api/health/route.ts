import { NextResponse } from "next/server";
import { API_VERSION } from "../../lib/api_contract";
import { embedMetadata } from "../../lib/backend";

export const runtime = "nodejs";

export async function GET() {
	const services: Record<string, unknown> = {
		api: "ok",
		auth: "ok",
		vault: "ok",
		qdrant: "unknown",
		embedder: "unknown",
	};

	try {
		await embedMetadata();
		services.embedder = "ok";
	} catch (error) {
		services.embedder = { status: "error", message: error instanceof Error ? error.message : "unknown" };
	}

	return NextResponse.json({ status: "ok", api_version: API_VERSION, services });
}
