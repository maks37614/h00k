/**
 * Auto Entry/TP/SL groups are idempotent in persistent storage, but checking
 * that persistence layer for every identical CONFIRMED setup on every six-
 * second worker tick costs O(number of saved alerts) per call. Remember only
 * successful creates/checks in this worker; a disk failure must remain retryable.
 *
 * This cache never stores a user's alerts or setup contents. Persistent alert
 * IDs and deletion tombstones remain the source of truth across restarts.
 */
export class AutoSetupGroupGate {
  private readonly completed = new Set<string>();

  constructor(private readonly limit = 256) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error('Auto setup group cache limit must be a positive integer');
  }

  /**
   * Returns true only when a persistence check ran and succeeded.
   * Existing groups and user-deleted groups are treated as completed: the
   * durable creation function already enforces idempotency/tombstones.
   */
  ensure(setupId: string, commit: () => { success: boolean }): boolean {
    if (!setupId) throw new Error('A setup identity is required');
    if (this.completed.has(setupId)) return false;

    // Do not mark a group until the storage operation succeeds. In particular
    // a failed atomic rename or invalid levels must be retried on a later tick.
    const result = commit();
    if (!result.success) return false;
    this.completed.add(setupId);
    if (this.completed.size > this.limit) {
      this.completed.delete(this.completed.values().next().value!);
    }
    return true;
  }

  clear(): void { this.completed.clear(); }
  size(): number { return this.completed.size; }
}
