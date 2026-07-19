import { reconcileAllUsersQdrantIndex } from "./qdrant_reconcile";

type SchedulerState = {
	started: boolean;
	running: boolean;
	timer: ReturnType<typeof setTimeout> | null;
};

const STATE_KEY = "__brainQdrantReconcileScheduler";

function getState(): SchedulerState {
	const globalScope = globalThis as typeof globalThis & { __brainQdrantReconcileScheduler?: SchedulerState };
	if (!globalScope[STATE_KEY]) {
		globalScope[STATE_KEY] = {
			started: false,
			running: false,
			timer: null,
		};
	}
	return globalScope[STATE_KEY]!;
}

function getScheduleTimeZone(): string {
	return process.env.QDRANT_RECONCILE_TIMEZONE ?? "America/New_York";
}

function getZonedParts(date: Date, timeZone: string): { year: number; month: number; day: number; weekday: string; hour: number; minute: number; second: number } {
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	});
	const parts = formatter.formatToParts(date);
	const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	return {
		year: Number(lookup.year ?? 1970),
		month: Number(lookup.month ?? 1),
		day: Number(lookup.day ?? 1),
		weekday: String(lookup.weekday ?? "Sun"),
		hour: Number(lookup.hour ?? 0),
		minute: Number(lookup.minute ?? 0),
		second: Number(lookup.second ?? 0),
	};
}

function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	});
	const parts = formatter.formatToParts(date);
	const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	const asUtc = Date.UTC(
		Number(lookup.year ?? 1970),
		Number(lookup.month ?? 1) - 1,
		Number(lookup.day ?? 1),
		Number(lookup.hour ?? 0),
		Number(lookup.minute ?? 0),
		Number(lookup.second ?? 0),
	);
	return Math.round((asUtc - date.getTime()) / 60000);
}

function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string): number {
	let utc = Date.UTC(year, month - 1, day, hour, minute, second);
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const offsetMinutes = getTimeZoneOffsetMinutes(new Date(utc), timeZone);
		const adjusted = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000;
		if (adjusted === utc) {
			return adjusted;
		}
		utc = adjusted;
	}
	return utc;
}

function getNextSundayMidnight(timeZone: string): number {
	const now = new Date();
	const current = getZonedParts(now, timeZone);
	const weekdayMap: Record<string, number> = {
		Sun: 0,
		Mon: 1,
		Tue: 2,
		Wed: 3,
		Thu: 4,
		Fri: 5,
		Sat: 6,
	};
	const currentDow = weekdayMap[current.weekday] ?? 0;
	const daysUntilSunday = currentDow === 0 ? 7 : (7 - currentDow) % 7;
	const targetDate = new Date(Date.UTC(current.year, current.month - 1, current.day, 0, 0, 0));
	targetDate.setUTCDate(targetDate.getUTCDate() + daysUntilSunday);
	return zonedTimeToUtc(
		targetDate.getUTCFullYear(),
		targetDate.getUTCMonth() + 1,
		targetDate.getUTCDate(),
		0,
		0,
		0,
		timeZone,
	);
}

function scheduleNextRun(): void {
	const state = getState();
	if (state.timer) {
		clearTimeout(state.timer);
		state.timer = null;
	}
	const targetAt = getNextSundayMidnight(getScheduleTimeZone());
	const delay = Math.max(targetAt - Date.now(), 1_000);
	state.timer = setTimeout(() => {
		void runOnce();
	}, delay);
	state.timer.unref?.();
}

async function runOnce(): Promise<void> {
	const state = getState();
	if (state.running) {
		return;
	}
	state.running = true;
	try {
		const summary = await reconcileAllUsersQdrantIndex({ repairMissing: true });
		console.info(
			`[qdrant-reconcile] completed tenants=${summary.inspected_tenants} files=${summary.inspected_files} missing=${summary.missing} repaired=${summary.repaired} skipped=${summary.skipped}`,
		);
	} catch (error) {
		console.error("[qdrant-reconcile] failed", error);
	} finally {
		state.running = false;
		scheduleNextRun();
	}
}

export function startQdrantReconcileScheduler(): void {
	const state = getState();
	if (state.started) {
		return;
	}
	state.started = true;
	scheduleNextRun();
}

export async function runQdrantReconcileNow(): Promise<void> {
	await runOnce();
}
