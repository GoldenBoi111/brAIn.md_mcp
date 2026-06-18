#!/usr/bin/env python3
"""Tiny Jasper embedding service used by the Qdrant-backed MCP server.

The service loads Jasper-Token-Compression-600M from Hugging Face and exposes:
- GET /health
- GET /metadata
- POST /embed { "texts": ["..."] }

If the model cannot be loaded, the service falls back to deterministic hash
embeddings so local development still works. For real deployments, keep the
model available and set JASPER_MODEL_NAME accordingly.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


MODEL_NAME = os.getenv("JASPER_MODEL_NAME", "infgrad/Jasper-Token-Compression-600M")
HOST = os.getenv("EMBEDDER_HOST", "0.0.0.0")
PORT = int(os.getenv("EMBEDDER_PORT", "8001"))
MAX_LENGTH = int(os.getenv("JASPER_MAX_LENGTH", "1024"))
VECTOR_SIZE = int(os.getenv("QDRANT_VECTOR_SIZE", "2048"))

_model_lock = threading.Lock()
_bundle: "JasperBundle | None" = None


class JasperBundle:
    def __init__(self) -> None:
        self.loaded = False
        self.fallback_reason: str | None = None
        self.tokenizer = None
        self.model = None
        self.torch = None
        self._dimension = VECTOR_SIZE
        self._load()

    def _load(self) -> None:
        try:
            import torch
            from transformers import AutoModel, AutoTokenizer

            tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME, trust_remote_code=True)
            model = AutoModel.from_pretrained(MODEL_NAME, trust_remote_code=True)
            model.eval()

            self.torch = torch
            self.tokenizer = tokenizer
            self.model = model
            self.loaded = True
            try:
                self._dimension = len(self.embed_texts(["dimension probe"])[0])
            except Exception:  # pragma: no cover - preserve fallback dimension
                self._dimension = VECTOR_SIZE
        except Exception as exc:  # pragma: no cover - network/model failures
            self.fallback_reason = f"{exc.__class__.__name__}: {exc}"
            self.loaded = False

    @property
    def dimension(self) -> int:
        return self._dimension

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        if self.loaded and self.tokenizer is not None and self.model is not None and self.torch is not None:
            tokens = self.tokenizer(
                texts,
                padding=True,
                truncation=True,
                max_length=MAX_LENGTH,
                return_tensors="pt",
            )
            with self.torch.no_grad():
                outputs = self.model(**tokens)
            hidden = getattr(outputs, "last_hidden_state", None)
            if hidden is None:
                hidden = outputs[0]
            mask = tokens["attention_mask"].unsqueeze(-1).to(hidden.dtype)
            pooled = (hidden * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1e-9)
            pooled = self.torch.nn.functional.normalize(pooled, p=2, dim=1)
            vectors = pooled.cpu().tolist()
            if vectors:
                return vectors

        return [self._fallback_embedding(text) for text in texts]

    def _fallback_embedding(self, text: str) -> list[float]:
        values = [0.0] * VECTOR_SIZE
        tokens = [self._normalize(token) for token in text.lower().split()]
        tokens = [token for token in tokens if token]
        if not tokens:
            return values
        for token in tokens:
            digest = hashlib.sha256(token.encode("utf-8")).digest()
            index = int.from_bytes(digest[:4], "big") % VECTOR_SIZE
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            values[index] += sign
        scale = max(1, len(tokens))
        return [value / scale for value in values]

    @staticmethod
    def _normalize(token: str) -> str:
        token = "".join(ch for ch in token if ch.isalnum())
        if len(token) > 4:
            for suffix in ("ing", "ed", "es", "s"):
                if token.endswith(suffix):
                    return token[: -len(suffix)]
        return token


def get_bundle() -> JasperBundle:
    global _bundle
    with _model_lock:
        if _bundle is None:
            _bundle = JasperBundle()
        return _bundle


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            bundle = get_bundle()
            self._send_json(
                200,
                {
                    "status": "ok",
                    "model_name": MODEL_NAME,
                    "loaded": bundle.loaded,
                    "fallback_reason": bundle.fallback_reason,
                    "dimension": bundle.dimension,
                },
            )
            return

        self._send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        content_length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(content_length).decode("utf-8") if content_length else "{}"
        try:
            payload = json.loads(raw or "{}")
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid_json"})
            return

        bundle = get_bundle()

        if self.path == "/metadata":
            self._send_json(
                200,
                {
                    "model_name": MODEL_NAME,
                    "loaded": bundle.loaded,
                    "fallback_reason": bundle.fallback_reason,
                    "dimension": bundle.dimension,
                    "vector_size": bundle.dimension,
                },
            )
            return

        if self.path == "/embed":
            texts = payload.get("texts")
            if not isinstance(texts, list) or not all(isinstance(item, str) for item in texts):
                self._send_json(400, {"error": "texts must be an array of strings"})
                return
            vectors = bundle.embed_texts(texts)
            self._send_json(
                200,
                {
                    "model_name": MODEL_NAME,
                    "dimension": bundle.dimension,
                    "vectors": vectors,
                },
            )
            return

        self._send_json(404, {"error": "not_found"})

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep container logs readable.
        return


def main() -> int:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Jasper embedder listening on {HOST}:{PORT}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
