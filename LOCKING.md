# Folder Locking Strategy for brAIn.md

## Overview

The brAIn.md vault system implements **application-level folder locking** via a JSON manifest stored in each vault. This document explains the current implementation and future research directions for OS-level or container-level enforcement.

## Current Implementation: JSON Manifest Locking

### How It Works

1. **Lock Manifest**: Each vault maintains a `.vault-locks.json` file in its root directory
   ```json
   {
     "locked_paths": [
       "Projects/Archived",
       "Documents/Confidential",
       "."
     ]
   }
   ```

2. **Path Matching**: Lock checking is prefix-based (hierarchical)
   - If `Projects/` is locked, all reads/writes to `Projects/Notes.md` fail
   - If `.` (vault root) is locked, all operations are blocked
   - Parent locks prevent child operations

3. **Enforcement**: Checked at three layers:
   - **Backend control plane** (`app/lib/backend.ts`): Core vault operations (`readFile`, `writeFile`, `createFolder`, `deletePath`, `movePath`)
   - **REST API** (`app/api/files/*`, `app/api/search/*`): User-facing HTTP endpoints
   - **MCP server** (`scripts/mcp_qdrant_server.py`): LLM-facing JSON-RPC interface

### Lock Operations

#### Locking Functions
```typescript
// Lock a single path
await lockPath(vaultRoot: string, relativePath: string): Promise<boolean>

// Unlock a single path
await unlockPath(vaultRoot: string, relativePath: string): Promise<boolean>

// Toggle lock state
await togglePathLock(vaultRoot: string, relativePath: string): Promise<boolean>

// Bulk operations
await lockPaths(vaultRoot: string, paths: string[]): Promise<number>
await unlockPaths(vaultRoot: string, paths: string[]): Promise<number>

// Query
await getLockedPaths(vaultRoot: string): Promise<string[]>
await isPathLocked(vaultRoot: string, path: string): Promise<boolean>
```

#### Lock Violations
When a locked path is accessed, the system throws:
```
BackendError: Path is locked: Projects/Archived
(status: 423 Locked)
```

### Audit Trail

Lock changes can be tracked via `performLockOperations()`:
```typescript
type LockAuditEntry = {
  timestamp: number;
  action: "lock" | "unlock";
  path: string;
  reason?: string;
  changedBy?: string;
};
```

## Advantages of Current Approach

✅ **Lightweight**: JSON file per vault, minimal I/O  
✅ **Portable**: Works across all filesystems (Windows, macOS, Linux)  
✅ **Fast**: In-memory set checks, no syscalls  
✅ **User-controlled**: Locking is a vault configuration, not OS admin action  
✅ **Reversible**: Easy to unlock or audit  
✅ **Compatible**: Works inside containers, over network volumes, with Git  

## Limitations

❌ **Not OS-enforced**: A user with filesystem access can bypass locks by direct file access  
❌ **No persistence layer**: Relies on app checking locks; doesn't prevent OS-level operations  
❌ **Single-user model**: Assumes a single application instance accesses the vault at a time  
❌ **No cross-machine coordination**: If multiple apps/machines access the same vault, locking is not atomic  

## Future Research: Layered Locking Strategy

### Level 1: Application Layer (Current)
- ✅ In place
- Prevents app-level lock violations
- Used by REST API and MCP server

### Level 2: OS Permissions (Windows/Linux)
**Goal**: Block direct filesystem access to locked folders  
**Technologies**:
- **Windows**: NTFS ACLs via `icacls` or WinAPI
- **Linux/macOS**: POSIX ACLs and `chattr +i` (immutable flag)

**Research needed**:
- When should OS-level locks be applied? (e.g., on lock operation, or on container startup?)
- How to manage permissions for the app process itself to still access locked folders for administrative tasks?
- Should locked folders be read-only, or completely inaccessible?

### Level 2B: Container-Level Isolation
**Goal**: Use Docker volumes, bind mounts, or seccomp policies to restrict access  
**Technologies**:
- Docker read-only bind mounts for locked directories
- seccomp profiles to block file operations on certain paths
- AppArmor/SELinux for mandatory access control

**Research needed**:
- How to dynamically mount/unmount volumes when lock state changes?
- Can volume remounting happen without container restart?
- Tradeoff: complexity vs. security guarantees

### Level 3: Distributed Lock Management
**Goal**: Coordinate locks across multiple instances or machines  
**Technologies**:
- Redis or Etcd for distributed lock state
- Lease-based locking (auto-unlock after timeout)
- Lock ownership tracking (which process/user locked a path?)

**Research needed**:
- Is distributed locking needed for the current use case?
- If so, should it be opt-in or default?
- How to handle split-brain scenarios (network partition)?

## Recommended Path

### Short term (Now)
✅ **Keep application-level JSON locking**. It's proven, portable, and sufficient for single-user/single-app scenarios.

### Medium term (Next release)
🔬 **Add OS-level read-only mode** for locked folders:
- Windows: Set ACLs to deny write access for the app user
- Linux: Use `chmod 444` or append-only mode
- Validate that the app can still read and admin-unlock the folder

### Long term (Research phase)
🧪 **Consider distributed locking** if multi-instance deployments become common  
🧪 **Consider seccomp/AppArmor** for containers if policy-based access control is required

## Migration Path (No Breaking Changes)

1. **Phase 1** (current): JSON locks, app-level enforcement
2. **Phase 2**: Add OS-level ACL layer (opt-in flag: `VAULT_LOCK_OS_ACL=true`)
3. **Phase 3**: If adopted widely, make it default but allow opt-out
4. **Phase 4**: Deprecate opt-out; OS-level locks are now required for security
5. **Phase 5** (if needed): Add distributed lock coordination

## Testing Checklist

- [ ] Lock a folder and verify REST API calls are blocked
- [ ] Lock a folder and verify MCP operations are blocked
- [ ] Unlock a folder and verify operations succeed
- [ ] Verify parent locks prevent child access
- [ ] Verify audit trail for lock operations
- [ ] Test lock race conditions (concurrent lock/unlock)
- [ ] Test with nested paths (e.g., lock "a/b", then try "a/b/c")
- [ ] Test with special characters in paths
- [ ] Verify locks persist across container restart (volume mount)
- [ ] Verify locked folders still show up in listings
- [ ] Test lock bypass attempts (direct filesystem access)

## API Reference

### REST Endpoints (To be added)

```http
# Get locked paths in a vault
GET /api/vault/locks?path=.

# Lock a path
POST /api/vault/locks
{ "action": "lock", "path": "Projects/Archived", "reason": "Old project" }

# Unlock a path
POST /api/vault/locks
{ "action": "unlock", "path": "Projects/Archived", "reason": "Project renewed" }

# Bulk lock operations
POST /api/vault/locks/batch
{ "operations": [
    { "action": "lock", "path": "a" },
    { "action": "unlock", "path": "b" }
  ]
}
```

### MCP Tools (Proposed)

```json
{
  "name": "lock_path",
  "description": "Lock a vault folder to prevent modifications",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "Relative path to lock" },
      "reason": { "type": "string", "description": "Reason for locking" }
    }
  }
}
```

## References

- [POSIX ACLs](https://www.kernel.org/doc/html/latest/filesystems/posix-acl.rst)
- [Windows NTFS ACLs](https://docs.microsoft.com/en-us/windows/security/authorization/access-control/access-control-lists)
- [Docker seccomp](https://docs.docker.com/engine/security/seccomp/)
- [Distributed Systems Locks](https://redis.io/docs/manage/sentinel/design-sentinel/)
