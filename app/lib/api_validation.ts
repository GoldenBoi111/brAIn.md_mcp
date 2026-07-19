import { BackendError } from "./backend";

export type JsonObject = Record<string, unknown>;

export function parseJsonObject(value: unknown): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return value as JsonObject;
}

export function asTrimmedString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed || null;
}

export function requireTrimmedString(value: unknown, fieldName: string): string {
	const result = asTrimmedString(value);
	if (!result) {
		throw new BackendError(`Missing ${fieldName}`, 400);
	}
	return result;
}

export function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map((item) => String(item));
}

export function asBoolean(value: unknown, defaultValue = false): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	return defaultValue;
}

export function asPositiveInteger(value: unknown, defaultValue: number, max = Number.MAX_SAFE_INTEGER): number {
	const numberValue = Number(value);
	if (!Number.isFinite(numberValue) || numberValue <= 0) {
		return defaultValue;
	}
	return Math.min(Math.floor(numberValue), max);
}

export function validatePathScope(value: unknown, defaultValue = "."): string {
	const pathValue = asTrimmedString(value);
	return pathValue ?? defaultValue;
}

export type VaultUsageQuery = {
	path: string;
	view: "tree" | "list";
};

export function validateVaultUsageQuery(url: URL): VaultUsageQuery {
	const view = url.searchParams.get("view");
	return {
		path: validatePathScope(url.searchParams.get("path")),
		view: view === "list" ? "list" : "tree",
	};
}

export type TokenCreateInput = {
	tokenName: string;
	subject: string;
	scopes: string[];
	readRoots: string[];
	writeRoots: string[];
	ttlDays?: number;
	issuer?: string;
	audience?: string;
	providerName?: string;
	description?: string;
	avatarUrl?: string;
	avatarAlt?: string;
	avatarBackground?: string;
};

export function validateTokenCreateBody(body: JsonObject): TokenCreateInput {
	const tokenName = asTrimmedString(body.tokenName ?? body.token_name) ?? "default";
	const subject = asTrimmedString(body.subject) ?? "";
	if (!subject) {
		throw new BackendError("Missing subject", 400);
	}
	const scopes = asStringArray(body.scopes);
	return {
		tokenName,
		subject,
		scopes: scopes.length ? scopes : ["mcp"],
		readRoots: asStringArray(body.readRoots ?? body.read_roots),
		writeRoots: asStringArray(body.writeRoots ?? body.write_roots),
		ttlDays: Number.isFinite(Number(body.ttlDays ?? body.ttl_days)) ? Number(body.ttlDays ?? body.ttl_days) : undefined,
		issuer: asTrimmedString(body.issuer) ?? undefined,
		audience: asTrimmedString(body.audience) ?? undefined,
		providerName: asTrimmedString(body.providerName ?? body.provider_name) ?? undefined,
		description: asTrimmedString(body.description) ?? undefined,
		avatarUrl: asTrimmedString(body.avatarUrl ?? body.avatar_url) ?? undefined,
		avatarAlt: asTrimmedString(body.avatarAlt ?? body.avatar_alt) ?? undefined,
		avatarBackground: asTrimmedString(body.avatarBackground ?? body.avatar_background) ?? undefined,
	};
}

export type TokenUpdateInput = {
	tokenName?: string;
	subject?: string;
	scopes?: string[];
	readRoots?: string[];
	writeRoots?: string[];
	issuer?: string;
	audience?: string;
	providerName?: string;
	description?: string;
	avatarUrl?: string;
	avatarAlt?: string;
	avatarBackground?: string;
	revoked?: boolean;
};

export function validateTokenUpdateBody(body: JsonObject): TokenUpdateInput {
	const result: TokenUpdateInput = {};
	const tokenName = asTrimmedString(body.tokenName ?? body.token_name);
	const subject = asTrimmedString(body.subject);
	const scopes = body.scopes;
	const readRoots = body.readRoots ?? body.read_roots;
	const writeRoots = body.writeRoots ?? body.write_roots;
	if (tokenName !== null) result.tokenName = tokenName;
	if (subject !== null) result.subject = subject;
	if (Array.isArray(scopes)) result.scopes = asStringArray(scopes);
	if (Array.isArray(readRoots)) result.readRoots = asStringArray(readRoots);
	if (Array.isArray(writeRoots)) result.writeRoots = asStringArray(writeRoots);
	const issuer = asTrimmedString(body.issuer);
	const audience = asTrimmedString(body.audience);
	const providerName = asTrimmedString(body.providerName ?? body.provider_name);
	const description = asTrimmedString(body.description);
	const avatarUrl = asTrimmedString(body.avatarUrl ?? body.avatar_url);
	const avatarAlt = asTrimmedString(body.avatarAlt ?? body.avatar_alt);
	const avatarBackground = asTrimmedString(body.avatarBackground ?? body.avatar_background);
	if (issuer !== null) result.issuer = issuer;
	if (audience !== null) result.audience = audience;
	if (providerName !== null) result.providerName = providerName;
	if (description !== null) result.description = description;
	if (avatarUrl !== null) result.avatarUrl = avatarUrl;
	if (avatarAlt !== null) result.avatarAlt = avatarAlt;
	if (avatarBackground !== null) result.avatarBackground = avatarBackground;
	if (typeof body.revoked === "boolean") result.revoked = body.revoked;
	return result;
}

export type UserCreateInput = {
	email: string;
	password: string;
	name?: string;
	role?: "admin" | "user";
};

export function validateUserCreateBody(body: JsonObject): UserCreateInput {
	const email = asTrimmedString(body.email);
	const password = typeof body.password === "string" ? body.password : "";
	if (!email) {
		throw new BackendError("Missing email", 400);
	}
	if (!password) {
		throw new BackendError("Missing password", 400);
	}
	return {
		email,
		password,
		name: asTrimmedString(body.name) ?? undefined,
		role: body.role === "admin" ? "admin" : "user",
	};
}

export type ReindexInput = {
	path: string;
	embeddingModel: string;
};

export function validateReindexBody(body: JsonObject): ReindexInput {
	return {
		path: validatePathScope(body.path),
		embeddingModel: asTrimmedString(body.embedding_model ?? body.embeddingModel) ?? "jasper-token-compression-600m",
	};
}

export type QdrantReconcileInput = {
	tenantId?: string;
	userId?: string;
	path: string;
	embeddingModel: string;
	repairMissing: boolean;
};

export function validateQdrantReconcileBody(body: JsonObject): QdrantReconcileInput {
	return {
		tenantId: asTrimmedString(body.tenantId ?? body.tenant_id) ?? undefined,
		userId: asTrimmedString(body.userId ?? body.user_id) ?? undefined,
		path: validatePathScope(body.path),
		embeddingModel: asTrimmedString(body.embedding_model ?? body.embeddingModel) ?? "jasper-token-compression-600m",
		repairMissing: typeof body.repairMissing === "boolean" ? body.repairMissing : true,
	};
}
