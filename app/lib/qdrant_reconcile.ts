import { createVault, getFileIdForPath, listPathsUnderPath, qdrantHasFilePoints, qdrantUpdateFile, readVaultFile } from "./backend";
import { BackendError } from "./errors";
import { listUsers } from "./user_auth";

export type QdrantReconcileFileResult = {
	path: string;
	file_id: string;
	qdrant_present: boolean;
	repaired: boolean;
	updated_chunks: number;
	error?: string;
};

export type QdrantReconcileTenantResult = {
	tenant_id: string;
	path: string;
	embedding_model: string;
	repair_missing: boolean;
	inspected: number;
	present: number;
	missing: number;
	repaired: number;
	skipped: number;
	results: QdrantReconcileFileResult[];
};

export type QdrantReconcileScope = {
	path?: string;
	embeddingModel?: string;
	repairMissing?: boolean;
};

export async function reconcileTenantQdrantIndex(tenantId: string, scope: QdrantReconcileScope = {}): Promise<QdrantReconcileTenantResult> {
	const path = scope.path?.trim() || ".";
	const embeddingModel = scope.embeddingModel?.trim() || "jasper-token-compression-600m";
	const repairMissing = scope.repairMissing ?? true;
	const vaultRoot = await createVault(tenantId);
	const candidatePaths = await listPathsUnderPath(vaultRoot, path);
	const fileTargets: Array<{ path: string; fileId: string }> = [];
	for (const candidatePath of candidatePaths) {
		const fileId = await getFileIdForPath(vaultRoot, candidatePath);
		if (!fileId) {
			continue;
		}
		fileTargets.push({ path: candidatePath, fileId });
	}

	const results: QdrantReconcileFileResult[] = [];
	let present = 0;
	let missing = 0;
	let repaired = 0;
	let skipped = 0;

	for (const target of fileTargets) {
		const qdrantPresent = await qdrantHasFilePoints({ tenantId, fileId: target.fileId, legacyFilePath: target.path });
		if (qdrantPresent) {
			present += 1;
			results.push({ path: target.path, file_id: target.fileId, qdrant_present: true, repaired: false, updated_chunks: 0 });
			continue;
		}

		missing += 1;
		if (!repairMissing) {
			results.push({ path: target.path, file_id: target.fileId, qdrant_present: false, repaired: false, updated_chunks: 0 });
			continue;
		}

		try {
			const content = await readVaultFile(vaultRoot, target.path);
			const update = await qdrantUpdateFile({
				tenantId,
				fileId: target.fileId,
				content,
				embeddingModel,
				legacyFilePath: target.path,
			});
			repaired += 1;
			results.push({
				path: target.path,
				file_id: target.fileId,
				qdrant_present: true,
				repaired: true,
				updated_chunks: update.created_or_updated_chunks,
			});
		} catch (error) {
			skipped += 1;
			results.push({
				path: target.path,
				file_id: target.fileId,
				qdrant_present: false,
				repaired: false,
				updated_chunks: 0,
				error: error instanceof Error ? error.message : "Unknown error",
			});
		}
	}

	return {
		tenant_id: tenantId,
		path,
		embedding_model: embeddingModel,
		repair_missing: repairMissing,
		inspected: fileTargets.length,
		present,
		missing,
		repaired,
		skipped,
		results,
	};
}

export async function reconcileAllUsersQdrantIndex(scope: QdrantReconcileScope = {}): Promise<{ inspected_tenants: number; inspected_files: number; present: number; missing: number; repaired: number; skipped: number; results: QdrantReconcileTenantResult[] }> {
	const users = await listUsers();
	const results: QdrantReconcileTenantResult[] = [];
	let inspectedFiles = 0;
	let present = 0;
	let missing = 0;
	let repaired = 0;
	let skipped = 0;

	for (const user of users) {
		const result = await reconcileTenantQdrantIndex(user.tenantId, scope);
		results.push(result);
		inspectedFiles += result.inspected;
		present += result.present;
		missing += result.missing;
		repaired += result.repaired;
		skipped += result.skipped;
	}

	return {
		inspected_tenants: users.length,
		inspected_files: inspectedFiles,
		present,
		missing,
		repaired,
		skipped,
		results,
	};
}

export async function reconcileTenantByUserId(userId: string, scope: QdrantReconcileScope = {}): Promise<QdrantReconcileTenantResult> {
	const users = await listUsers();
	const user = users.find((entry) => entry.id === userId);
	if (!user) {
		throw new BackendError(`Unknown user: ${userId}`, 404);
	}
	return reconcileTenantQdrantIndex(user.tenantId, scope);
}
