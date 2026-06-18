import { NextResponse } from "next/server";
import { BackendError, embedMetadata, embedPayload } from "../../lib/backend";
import { requireUserSession } from "../../lib/user_auth";

export const runtime = "nodejs";

function errorResponse(error: unknown): NextResponse {
  if (error instanceof BackendError) {
    const backendError = error as BackendError;
    return NextResponse.json({ error: backendError.message }, { status: backendError.status });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function POST(request: Request) {
  try {
    await requireUserSession(request);
    const body: any = await request.json().catch(() => ({}));
    const texts = Array.isArray(body?.texts)
      ? body.texts.map((value: unknown) => String(value))
      : typeof body?.text === "string"
        ? [body.text]
        : [];
    if (!texts.length) {
      throw new BackendError("Expected a text or texts array", 400);
    }

    const result = await embedPayload(texts);
    const includeMetadata = body?.include_metadata === true;
    if (!includeMetadata) {
      return NextResponse.json({ vectors: result.vectors, model_name: result.model_name, dimension: result.dimension });
    }

    const metadata = await embedMetadata();
    return NextResponse.json({
      vectors: result.vectors,
      model_name: result.model_name,
      dimension: result.dimension,
      metadata,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET() {
  return NextResponse.json({
    route: "/api/embed",
    method: "POST",
    auth: "required",
    body: {
      text: "string or texts: string[]",
      include_metadata: false,
    },
  });
}
