import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { Request } from "express";
export function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}
export const opaqueToken = () => randomBytes(32).toString("base64url");
export const tokenHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    fail("Некоректний ідентифікатор");
  return value;
}
export function bounded(value: unknown, max = 10_000): string {
  if (typeof value !== "string" || value.length > max)
    fail("Текст завеликий або має неправильний формат");
  return value.trim();
}
function secretKey() {
  const key = Buffer.from(process.env.COMMUNITY_ENCRYPTION_KEY ?? "", "base64");
  if (key.length !== 32) fail("Захищене сховище ключів ще не налаштоване", 503);
  return key;
}
export function seal(value: string, owner: string): string {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  cipher.setAAD(Buffer.from(owner));
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), ciphertext]
    .map((b) => b.toString("base64url"))
    .join(".");
}
export function unseal(value: string, owner: string): string {
  const [iv, tag, ciphertext] = value
    .split(".")
    .map((p) => Buffer.from(p, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", secretKey(), iv);
  cipher.setAAD(Buffer.from(owner));
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString(
    "utf8",
  );
}
export function sessionCookie(req: Request): string {
  const value =
    req.headers?.cookie
      ?.split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith("h00k_session="))
      ?.slice(13) ?? "";
  return /^[A-Za-z0-9_-]{40,60}$/.test(value) ? value : "";
}
export function checkMutation(req: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  if (req.get("X-H00K-Request") !== "1")
    fail("Потрібне підтвердження запиту", 403);
  const origin = req.get("Origin");
  const allowed = [
    process.env.APP_ORIGIN || "http://localhost:3000",
    process.env.COMMUNITY_PUBLIC_ORIGINS || "",
  ]
    .join(",")
    .split(",")
    .map((s) => s.trim());
  if (origin && !allowed.includes(origin))
    fail("Недозволене джерело запиту", 403);
}
/** Bounded in-process backstop; edge limits are required when running more than one replica. */
export class RequestLimits {
  private windows = new Map<string, { until: number; count: number }>();
  take(key: string, max: number, ms = 60_000) {
    const now = Date.now();
    let window = this.windows.get(key);
    if (!window || window.until <= now) {
      window = { until: now + ms, count: 0 };
      this.windows.set(key, window);
    }
    if (++window.count > max) fail("Забагато запитів. Спробуйте пізніше.", 429);
    if (this.windows.size > 10_000) {
      for (const [id, entry] of this.windows)
        if (entry.until <= now) this.windows.delete(id);
      if (this.windows.size > 20_000)
        fail("Сервіс тимчасово перевантажений", 503);
    }
  }
}
