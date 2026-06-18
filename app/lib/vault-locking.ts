// Vault Locking Utilities
// High-level helpers for common folder locking patterns.

import { loadLockSet, saveLockSet } from "./backend";

export type LockOperation = {
  action: "lock" | "unlock" | "toggle";
  path: string;
  reason?: string;
};

export type LockAuditEntry = {
  timestamp: number;
  action: "lock" | "unlock";
  path: string;
  reason?: string;
  changedBy?: string;
};

export async function lockPath(vaultRoot: string, path: string): Promise<boolean> {
  const locks = await loadLockSet(vaultRoot);
  if (locks.has(path)) {
    return false;
  }
  locks.add(path);
  await saveLockSet(vaultRoot, locks);
  return true;
}

export async function unlockPath(vaultRoot: string, path: string): Promise<boolean> {
  const locks = await loadLockSet(vaultRoot);
  if (!locks.has(path)) {
    return false;
  }
  locks.delete(path);
  await saveLockSet(vaultRoot, locks);
  return true;
}

export async function isPathLocked(vaultRoot: string, path: string): Promise<boolean> {
  const locks = await loadLockSet(vaultRoot);
  if (locks.has(path) || locks.has(".")) {
    return true;
  }
  const parts = path.split("/");
  let prefix = "";
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    if (locks.has(prefix)) {
      return true;
    }
  }
  return false;
}

export async function getLockedPaths(vaultRoot: string): Promise<string[]> {
  const locks = await loadLockSet(vaultRoot);
  return Array.from(locks).sort();
}

export async function lockPaths(vaultRoot: string, paths: string[]): Promise<number> {
  const locks = await loadLockSet(vaultRoot);
  const before = locks.size;
  for (const path of paths) {
    locks.add(path);
  }
  await saveLockSet(vaultRoot, locks);
  return locks.size - before;
}

export async function unlockPaths(vaultRoot: string, paths: string[]): Promise<number> {
  const locks = await loadLockSet(vaultRoot);
  const before = locks.size;
  for (const path of paths) {
    locks.delete(path);
  }
  await saveLockSet(vaultRoot, locks);
  return before - locks.size;
}

export async function clearAllLocks(vaultRoot: string): Promise<void> {
  await saveLockSet(vaultRoot, []);
}

export async function setLocks(vaultRoot: string, paths: string[]): Promise<void> {
  await saveLockSet(vaultRoot, paths);
}

export async function lockPathsWithAudit(
  vaultRoot: string,
  paths: string[],
  reason?: string,
): Promise<LockAuditEntry[]> {
  const audits: LockAuditEntry[] = [];
  for (const path of paths) {
    if (await lockPath(vaultRoot, path)) {
      audits.push({
        timestamp: Date.now(),
        action: "lock",
        path,
        reason,
      });
    }
  }
  return audits;
}

export async function unlockPathsWithAudit(
  vaultRoot: string,
  paths: string[],
  reason?: string,
): Promise<LockAuditEntry[]> {
  const audits: LockAuditEntry[] = [];
  for (const path of paths) {
    if (await unlockPath(vaultRoot, path)) {
      audits.push({
        timestamp: Date.now(),
        action: "unlock",
        path,
        reason,
      });
    }
  }
  return audits;
}

export async function filterByLockStatus(
  vaultRoot: string,
  paths: string[],
  locked: boolean
): Promise<string[]> {
  const locks = await loadLockSet(vaultRoot);
  return paths.filter(path => {
    const isLocked = isPathLockedSync(path, locks);
    return locked ? isLocked : !isLocked;
  });
}

function isPathLockedSync(path: string, locks: Set<string>): boolean {
  if (locks.has(path) || locks.has(".")) {
    return true;
  }
  const parts = path.split("/");
  let prefix = "";
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    if (locks.has(prefix)) {
      return true;
    }
  }
  return false;
}

export async function toggleLock(vaultRoot: string, path: string): Promise<boolean> {
  const locks = await loadLockSet(vaultRoot);
  if (locks.has(path)) {
    locks.delete(path);
    await saveLockSet(vaultRoot, locks);
    return false;
  } else {
    locks.add(path);
    await saveLockSet(vaultRoot, locks);
    return true;
  }
}

export async function performLockOperations(
  vaultRoot: string,
  operations: LockOperation[]
): Promise<LockAuditEntry[]> {
  const locks = await loadLockSet(vaultRoot);
  const audits: LockAuditEntry[] = [];
  
  for (const op of operations) {
    let changed = false;
    if (op.action === "lock") {
      if (!locks.has(op.path)) {
        locks.add(op.path);
        changed = true;
      }
    } else if (op.action === "unlock") {
      if (locks.has(op.path)) {
        locks.delete(op.path);
        changed = true;
      }
    } else if (op.action === "toggle") {
      if (locks.has(op.path)) {
        locks.delete(op.path);
      } else {
        locks.add(op.path);
      }
      changed = true;
    }
    
    if (changed) {
      audits.push({
        timestamp: Date.now(),
        action: op.action === "toggle" ? (locks.has(op.path) ? "lock" : "unlock") : op.action,
        path: op.path,
        reason: op.reason,
      });
    }
  }
  
  if (audits.length > 0) {
    await saveLockSet(vaultRoot, locks);
  }
  
  return audits;
}
