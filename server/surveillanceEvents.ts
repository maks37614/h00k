/** Per-account invalidation signals; no private data leaves this module. */
type Listener = (version: number) => void;
const listeners = new Map<string, Set<Listener>>();
const lastPublished = new Map<string, number>();
const lastVersion = new Map<string, number>();
const MAX_CONNECTIONS = 512;
const MAX_CONNECTIONS_PER_USER = 3;
let clients = 0;
export function subscribeSurveillance(userId: string, listener: Listener): (() => void) | null {
  if (!userId || userId === 'guest' || clients >= MAX_CONNECTIONS) return null;
  let set = listeners.get(userId);
  if (set && set.size >= MAX_CONNECTIONS_PER_USER) return null;
  if (!set) { set = new Set(); listeners.set(userId, set); }
  set.add(listener);
  clients++;
  return () => {
    if (!set?.delete(listener)) return;
    clients--;
    if (!set.size) { listeners.delete(userId); lastPublished.delete(userId); lastVersion.delete(userId); }
  };
}
/** Coalesce updates from many private workers to at most one per 15 seconds. */
export function publishSurveillance(userId: string, force = false, now = Date.now()): void {
  const set = listeners.get(userId);
  if (!set?.size) return;
  if (!force && now - (lastPublished.get(userId) ?? -Infinity) < 15000) return;
  lastPublished.set(userId, now);
  const version = (lastVersion.get(userId) ?? 0) + 1;
  lastVersion.set(userId, version);
  for (const listener of [...set]) { try { listener(version); } catch {} }
}
export function surveillanceStreamStats() { return { clients, users: listeners.size, limit: MAX_CONNECTIONS }; }
