function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function getPublicOrigin(request: Request): string {
  const envOrigin = normalizeOrigin(process.env.NEXT_PUBLIC_APP_URL);
  if (envOrigin) return envOrigin;

  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  const host = request.headers.get("host");
  if (host) {
    const proto = forwardedProto ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
    return `${proto}://${host}`;
  }

  return new URL(request.url).origin;
}
