import { verify, createPublicKey } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { accountFor } from "./community/session";
import { postgres } from "./community/db";
import { checkMutation, sessionCookie } from "./community/security";

/** Optional short-lived h00k service tokens; never accept Firebase tokens or caller-selected owners. */
export async function verifyH00kToken(token: string): Promise<string> {
  const invalid = () =>
    Object.assign(new Error("Сесія входу недійсна або закінчилась"), {
      status: 401,
    });
  if (!process.env.H00K_AUTH_PUBLIC_KEY || token.length > 12000)
    throw invalid();
  const [h, b, s, ...rest] = token.split(".");
  if (rest.length || !h || !b || !s) throw invalid();
  try {
    const header = JSON.parse(Buffer.from(h, "base64url").toString()),
      claims = JSON.parse(Buffer.from(b, "base64url").toString()),
      now = Date.now() / 1000;
    if (
      header.alg !== "RS256" ||
      claims.aud !== "h00k.top" ||
      claims.iss !== "h00k" ||
      typeof claims.sub !== "string" ||
      !claims.sub.trim() ||
      claims.sub === "guest" ||
      claims.sub.length > 128 ||
      typeof claims.exp !== "number" ||
      claims.exp <= now ||
      typeof claims.iat !== "number" ||
      claims.iat > now + 30 ||
      claims.exp - claims.iat > 3600 ||
      typeof claims.auth_time !== "number" ||
      claims.auth_time > now + 30
    )
      throw invalid();
    if (
      !verify(
        "RSA-SHA256",
        Buffer.from(h + "." + b),
        createPublicKey(process.env.H00K_AUTH_PUBLIC_KEY),
        Buffer.from(s, "base64url"),
      )
    )
      throw invalid();
    return claims.sub;
  } catch {
    throw invalid();
  }
}
export async function requireUserAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const bearer = req
      .get("Authorization")
      ?.match(/^Bearer ([A-Za-z0-9_.-]+)$/i);
    let userId: string;
    if (bearer) userId = await verifyH00kToken(bearer[1]);
    else {
      if (!sessionCookie(req))
        throw Object.assign(new Error("Увійдіть у свій акаунт"), {
          status: 401,
        });
      checkMutation(req);
      const account = await accountFor(postgres(), req);
      if (!account)
        throw Object.assign(new Error("Увійдіть у свій акаунт"), {
          status: 401,
        });
      userId = account.id;
    }
    if (
      [req.query.userId, req.body?.userId].some(
        (id) => id !== undefined && id !== userId,
      )
    )
      throw Object.assign(
        new Error("Немає доступу до даних іншого користувача"),
        { status: 403 },
      );
    req.query.userId = userId;
    req.body = { ...(req.body ?? {}), userId };
    res.locals.userId = userId;
    next();
  } catch (error: any) {
    res
      .status(error.status ?? 503)
      .json({
        success: false,
        error: error.status
          ? error.message
          : "Сервіс входу тимчасово недоступний",
      });
  }
}
