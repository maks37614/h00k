import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const file = path.join(process.cwd(), "server/data/deleted_accounts.json");
let deleted: Set<string> | undefined;
const hash = (id: string) => createHash("sha256").update(id).digest("hex");
function load() {
  if (!deleted) {
    const raw = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : [];
    if (
      !Array.isArray(raw) ||
      raw.some((v) => typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v))
    )
      throw new Error("Invalid account tombstones");
    deleted = new Set(raw);
  }
  return deleted;
}
export const isDeletedAccount = (id?: string) => !!id && load().has(hash(id));
export function assertActiveMarketAccount(id: string) {
  if (isDeletedAccount(id)) throw new Error("Акаунт видалено");
}
export function markAccountDeleted(id: string) {
  if (!/^[a-f0-9-]{36}$/i.test(id))
    throw new Error("Native account UUID required");
  const next = new Set(load());
  next.add(hash(id));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify([...next]), { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
  deleted = next;
}
