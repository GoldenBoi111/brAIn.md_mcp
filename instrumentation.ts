import { startQdrantReconcileScheduler } from "./app/lib/qdrant_reconcile_scheduler";

export async function register(): Promise<void> {
	startQdrantReconcileScheduler();
}
