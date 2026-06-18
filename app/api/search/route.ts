import { NextResponse } from "next/server";
import {
  BackendError,
  createVault,
  embedText,
  getPathForFileId,
  pathWithinRoots,
  qdrantSearch,
} from "../../lib/backend";
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
    const claims = await requireUserSession(request);
    const body: any = await request.json().catch(() => ({}));
    const query = String(body?.query ?? "").trim();
    if (!query) {
      throw new BackendError("Missing query", 400);
    }
    const topK = Number(body?.top_k ?? body?.topK ?? 10);
    const vaultRoot = await createVault(claims.tenantId);
    const queryVector = await embedText(query);
    const matches = await qdrantSearch({
      tenantId: claims.tenantId,
      queryVector,
      topK: Number.isFinite(topK) && topK > 0 ? Math.min(topK, 50) : 10,
    });

    const results = [];
    for (const match of matches) {
      const pathFromCatalog = match.file_id ? await getPathForFileId(vaultRoot, match.file_id) : null;
      const relativePath = pathFromCatalog ?? match.legacy_file_path ?? null;
      if (!relativePath) continue;
      if (!pathWithinRoots(relativePath, claims.readRoots)) continue;
      results.push({
        file_id: match.file_id,
        relative_path: relativePath,
        score: match.score,
        chunk_index: match.chunk_index,
        embedding_model: match.embedding_model,
      });
    }

    return NextResponse.json({
      tenant_id: claims.tenantId,
      query,
      top_k: topK,
      matches: results,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET() {
  return NextResponse.json({
    route: "/api/search",
    method: "POST",
    auth: "required",
    body: {
      query: "string",
      top_k: 10,
    },
  });
}
