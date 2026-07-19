export async function register(): Promise<void> {
	if (process.env.NEXT_RUNTIME === "edge") {
		return;
	}
	const { startQdrantReconcileScheduler } = await import("./app/lib/qdrant_reconcile_scheduler");
	startQdrantReconcileScheduler();
}
