import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import * as OTPAuth from "otpauth";
import nodemailer from "nodemailer";
import type { Database } from "./db";
import {
  bounded,
  checkMutation,
  fail,
  opaqueToken,
  RequestLimits,
  seal,
  sessionCookie,
  tokenHash,
  unseal,
} from "./security";
import { mergeProfileUpdate } from "../../src/utils/hookchartData";

import { accountFor, type Account } from "./session";
export { accountFor };
export type { Account };
export function present(account: Account) {
  const profile = { ...account.profile, uid: account.id, email: account.email };
  delete profile.telegramBotToken;
  delete profile.telegramChatId;
  delete profile.telegramBotUsername;
  return {
    user: {
      uid: account.id,
      email: account.email,
      displayName: profile.displayName ?? "",
      photoURL: profile.photoURL ?? "",
      emailVerified: account.email_verified,
    },
    profile,
    security: {
      emailVerified: account.email_verified,
      mfaEnabled: !!account.mfa_secret,
      strong: account.strong,
    },
  };
}
async function newSession(
  db: Database,
  userId: string,
  res: Response,
  strong: boolean,
) {
  const token = opaqueToken();
  await db.query(
    `INSERT INTO hc_sessions(token_hash,user_id,expires_at,last_strong_auth) VALUES($1,$2,now()+interval '7 days',$3)`,
    [tokenHash(token), userId, strong ? new Date() : null],
  );
  res.cookie("h00k_session", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 86400_000,
  });
}
function password(value: unknown) {
  if (typeof value !== "string" || value.length < 15 || value.length > 256)
    fail("Пароль має містити від 15 до 256 символів");
  return value;
}
function otp(secret: string) {
  return new OTPAuth.TOTP({
    issuer: "h00k",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret,
  });
}
function validOtp(secret: string, value: unknown) {
  return (
    typeof value === "string" &&
    /^\d{6}$/.test(value) &&
    otp(secret).validate({ token: value, window: 1 }) !== null
  );
}
type Mail = (email: string, subject: string, url: string) => Promise<void>;
const sendMail: Mail = async (email, subject, url) => {
  if (
    !process.env.SMTP_URL ||
    !process.env.MAIL_FROM ||
    !process.env.APP_ORIGIN
  )
    fail("Доставка email ще не налаштована", 503);
  const mailer = nodemailer.createTransport(process.env.SMTP_URL);
  await mailer.sendMail({
    from: process.env.MAIL_FROM,
    to: email,
    subject,
    text: `${subject}\n\n${url}\n\nЯкщо ви не робили цей запит, проігноруйте повідомлення.`,
  });
};
export function installAccountRoutes(
  app: Express,
  getDb: () => Database,
  mail: Mail = sendMail,
) {
  const limits = new RequestLimits();
  let passwordOperations = 0;
  const route = (
    method: "get" | "post" | "patch" | "delete",
    path: string,
    run: (
      req: Request,
      res: Response,
      db: Database,
      account: Account | null,
    ) => Promise<void>,
    auth = true,
  ) => {
    app[method](`/api/account${path}`, async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      res.set("X-Content-Type-Options", "nosniff");
      let hashSlot = false;
      try {
        checkMutation(req);
        limits.take(`ip:${req.ip}`, method === "get" ? 180 : 40);
        if (["/register", "/login", "/reset", "/mfa/setup"].includes(path)) {
          if (passwordOperations >= 2)
            fail("Сервіс входу зайнятий. Повторіть запит.", 503);
          passwordOperations++;
          hashSlot = true;
        }
        const db = getDb(),
          account = await accountFor(db, req);
        if (auth && !account) fail("Увійдіть у свій акаунт", 401);
        await run(req, res, db, account);
      } catch (error: any) {
        res.status(error.status ?? 503).json({
          success: false,
          error: error.status
            ? error.message
            : "Сервіс акаунтів тимчасово недоступний",
        });
      } finally {
        if (hashSlot) passwordOperations--;
      }
    });
  };
  route(
    "get",
    "/me",
    async (_req, res, _db, a) => {
      res.json({
        success: true,
        ...(a ? present(a) : { user: null, profile: null }),
      });
    },
    false,
  );
  route(
    "post",
    "/register",
    async (req, res, db) => {
      const email = bounded(req.body.email, 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("Перевірте email");
      limits.take("register:" + req.ip, 5, 3600_000);
      const pass = password(req.body.password),
        id = randomUUID(),
        displayName = bounded(req.body.displayName ?? "", 100);
      // Exactly the same slow hash path is used independently of account existence.
      const hash = await argon2.hash(pass, {
        type: argon2.argon2id,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      });
      const profile = {
        uid: id,
        displayName: displayName || "Трейдер",
        timeZone: "auto",
        watchlist: [],
        watchlistFolders: {},
        chartLabelSettings: { entry: true, target: true, stop: true },
        installGuideTipShown: false,
        createdAt: new Date().toISOString(),
      };
      try {
        await db.query(
          "INSERT INTO hc_users(id,email,password_hash,profile) VALUES($1,$2,$3,$4)",
          [id, email, hash, profile],
        );
      } catch (error: any) {
        if (error.code === "23505")
          fail(
            "Не вдалося створити акаунт. Спробуйте вхід або відновлення доступу.",
            409,
          );
        throw error;
      }
      await newSession(db, id, res, false);
      res.status(201).json({
        success: true,
        ...present({
          id,
          email,
          email_verified: false,
          profile,
          mfa_secret: null,
          strong: false,
          tokenHash: "",
        }),
      });
    },
    false,
  );
  route(
    "post",
    "/login",
    async (req, res, db) => {
      const email = bounded(req.body.email, 254).toLowerCase();
      limits.take("login:" + tokenHash(email), 10, 900_000);
      const { rows } = await db.query("SELECT * FROM hc_users WHERE email=$1", [
        email,
      ]);
      const user = rows[0];
      const fallback =
        "$argon2id$v=19$m=19456,t=2,p=1$SW52YWxpZFVzZXJTYWx0MQ$6Fwt8UL0Nfc4x0SZYQKpm5m8/xcHnQ3P+PvByXYhaUk";
      const good = await argon2
        .verify(
          user?.password_hash ?? fallback,
          typeof req.body.password === "string"
            ? req.body.password.slice(0, 256)
            : "",
        )
        .catch(() => false);
      if (!user || !good) fail("Неправильний email або пароль", 401);
      if (
        user.mfa_secret &&
        !validOtp(unseal(user.mfa_secret, user.id), req.body.code)
      )
        fail("Введіть код двофакторної перевірки", 401);
      await newSession(db, user.id, res, !!user.mfa_secret);
      res.json({
        success: true,
        ...present({ ...user, strong: !!user.mfa_secret, tokenHash: "" }),
      });
    },
    false,
  );
  route("post", "/logout", async (_req, res, db, a) => {
    await db.query("DELETE FROM hc_sessions WHERE token_hash=$1", [
      a!.tokenHash,
    ]);
    res.clearCookie("h00k_session", { path: "/" });
    res.json({ success: true });
  });
  route("post", "/logout-all", async (_req, res, db, a) => {
    await db.query("DELETE FROM hc_sessions WHERE user_id=$1", [a!.id]);
    res.clearCookie("h00k_session", { path: "/" });
    res.json({ success: true });
  });
  route("patch", "/profile", async (req, res, db, a) => {
    const patch = { ...req.body };
    for (const key of [
      "uid",
      "email",
      "emailVerified",
      "telegramBotToken",
      "telegramChatId",
      "telegramBotUsername",
      "verified",
      "role",
      "points",
    ])
      delete patch[key];
    if (patch.displayName !== undefined)
      patch.displayName = bounded(patch.displayName, 100);
    if (patch.photoURL !== undefined) {
      patch.photoURL = bounded(patch.photoURL, 2000);
      if (patch.photoURL && !/^https:\/\//.test(patch.photoURL))
        fail("Аватар має використовувати HTTPS");
    }
    if (
      patch.watchlist !== undefined &&
      (!Array.isArray(patch.watchlist) ||
        patch.watchlist.length > 2000 ||
        patch.watchlist.some(
          (v: any) => typeof v !== "string" || v.length > 100,
        ))
    )
      fail("Некоректний список обраного");
    if (patch.community !== undefined) {
      const raw = patch.community;
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        fail("Некоректні налаштування спільноти");
      const clean: Record<string, any> = {};
      for (const key of ["bio", "interests", "lifestyle", "telegram"])
        if (raw[key] !== undefined) clean[key] = bounded(raw[key], 2000);
      for (const key of [
        "bioAudience",
        "interestsAudience",
        "lifestyleAudience",
        "telegramAudience",
        "statisticsAudience",
        "tradesAudience",
        "amountsAudience",
        "notesAudience",
      ]) {
        if (raw[key] !== undefined) {
          if (!["private", "friends", "public"].includes(raw[key]))
            fail("Некоректна аудиторія");
          clean[key] = raw[key];
        }
      }
      if (raw.rankingPublic !== undefined)
        clean.rankingPublic = raw.rankingPublic === true;
      if (raw.status !== undefined) {
        if (
          !raw.status ||
          typeof raw.status !== "object" ||
          !["private", "friends", "public", undefined].includes(
            raw.status.audience,
          )
        )
          fail("Некоректний статус");
        clean.status = {
          text: bounded(raw.status.text ?? "", 280),
          audience: raw.status.audience ?? "private",
          ...(raw.status.expiresAt &&
          Number.isFinite(Date.parse(raw.status.expiresAt))
            ? { expiresAt: new Date(raw.status.expiresAt).toISOString() }
            : {}),
        };
      }
      patch.community = clean;
    }
    if (JSON.stringify(patch).length > 500_000) fail("Налаштування завеликі");
    const profile = await db.transaction(async (tx) => {
      const { rows } = await tx.query(
        "SELECT profile FROM hc_users WHERE id=$1 FOR UPDATE",
        [a!.id],
      );
      const merged = mergeProfileUpdate(
        { ...rows[0].profile, uid: a!.id },
        patch,
      );
      await tx.query("UPDATE hc_users SET profile=$2 WHERE id=$1", [
        a!.id,
        merged,
      ]);
      return merged;
    });
    res.json({
      success: true,
      profile: { ...profile, uid: a!.id, email: a!.email },
    });
  });
  route("post", "/verify/request", async (_req, res, db, a) => {
    limits.take("verify:" + a!.id, 3, 3600_000);
    const token = opaqueToken();
    await mail(
      a!.email,
      "Підтвердження email h00k",
      `${process.env.APP_ORIGIN}/?verify=${token}#community?section=settings`,
    );
    await db.query(
      `INSERT INTO hc_tokens(token_hash,user_id,purpose,expires_at) VALUES($1,$2,'verify',now()+interval '30 minutes')`,
      [tokenHash(token), a!.id],
    );
    res.json({ success: true });
  });
  route(
    "post",
    "/verify",
    async (req, res, db) => {
      await db.transaction(async (tx) => {
        const { rows } = await tx.query(
          `DELETE FROM hc_tokens WHERE token_hash=$1 AND purpose='verify' AND expires_at>now() RETURNING user_id`,
          [tokenHash(bounded(req.body.token, 100))],
        );
        if (!rows.length) fail("Посилання недійсне або прострочене");
        await tx.query("UPDATE hc_users SET email_verified=true WHERE id=$1", [
          rows[0].user_id,
        ]);
      });
      res.json({ success: true });
    },
    false,
  );
  route(
    "post",
    "/reset/request",
    async (req, res, db) => {
      const email = bounded(req.body.email, 254).toLowerCase();
      limits.take("reset:" + tokenHash(email), 3, 3600_000);
      const { rows } = await db.query(
        "SELECT id,email FROM hc_users WHERE email=$1",
        [email],
      );
      if (rows.length) {
        const token = opaqueToken();
        try {
          await db.query(
            `INSERT INTO hc_tokens(token_hash,user_id,purpose,expires_at) VALUES($1,$2,'reset',now()+interval '15 minutes')`,
            [tokenHash(token), rows[0].id],
          );
          await mail(
            email,
            "Відновлення доступу h00k",
            `${process.env.APP_ORIGIN}/?reset=${token}`,
          );
        } catch {
          console.warn("Account recovery delivery unavailable");
        }
      }
      res.json({
        success: true,
        message: "Якщо акаунт існує, інструкцію надіслано.",
      });
    },
    false,
  );
  route(
    "post",
    "/reset",
    async (req, res, db) => {
      const pass = password(req.body.password),
        hash = await argon2.hash(pass, {
          type: argon2.argon2id,
          memoryCost: 19456,
          timeCost: 2,
          parallelism: 1,
        });
      await db.transaction(async (tx) => {
        const { rows } = await tx.query(
          `SELECT t.user_id,u.mfa_secret FROM hc_tokens t JOIN hc_users u ON u.id=t.user_id WHERE t.token_hash=$1 AND purpose='reset' AND expires_at>now() FOR UPDATE`,
          [tokenHash(bounded(req.body.token, 100))],
        );
        if (!rows.length) fail("Посилання недійсне або прострочене");
        const u = rows[0];
        if (
          u.mfa_secret &&
          !validOtp(unseal(u.mfa_secret, u.user_id), req.body.code)
        )
          fail("Потрібен другий фактор", 401);
        await tx.query("UPDATE hc_users SET password_hash=$2 WHERE id=$1", [
          u.user_id,
          hash,
        ]);
        await tx.query("DELETE FROM hc_tokens WHERE user_id=$1", [u.user_id]);
        await tx.query("DELETE FROM hc_sessions WHERE user_id=$1", [u.user_id]);
      });
      res.clearCookie("h00k_session", { path: "/" });
      res.json({ success: true });
    },
    false,
  );
  route("post", "/mfa/setup", async (req, res, db, a) => {
    const { rows } = await db.query(
      "SELECT password_hash FROM hc_users WHERE id=$1",
      [a!.id],
    );
    if (
      !(await argon2
        .verify(
          rows[0].password_hash,
          typeof req.body.password === "string" ? req.body.password : "",
        )
        .catch(() => false))
    )
      fail("Підтвердіть пароль", 401);
    if (a!.mfa_secret && !a!.strong)
      fail("Потрібна поточна двофакторна перевірка", 403);
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    await db.query("UPDATE hc_users SET mfa_pending=$2 WHERE id=$1", [
      a!.id,
      seal(JSON.stringify({ secret, expires: Date.now() + 900_000 }), a!.id),
    ]);
    res.json({
      success: true,
      secret,
      uri: new OTPAuth.TOTP({
        issuer: "h00k",
        label: a!.email,
        secret,
      }).toString(),
    });
  });
  route("post", "/mfa/confirm", async (req, res, db, a) => {
    const { rows } = await db.query(
      "SELECT mfa_pending FROM hc_users WHERE id=$1",
      [a!.id],
    );
    if (!rows[0].mfa_pending) fail("Спочатку налаштуйте другий фактор");
    const pending = JSON.parse(unseal(rows[0].mfa_pending, a!.id));
    if (
      pending.expires < Date.now() ||
      !validOtp(pending.secret, req.body.code)
    )
      fail("Некоректний або прострочений код");
    await db.transaction(async (tx) => {
      await tx.query(
        "UPDATE hc_users SET mfa_secret=$2,mfa_pending=NULL WHERE id=$1",
        [a!.id, seal(pending.secret, a!.id)],
      );
      await tx.query(
        "DELETE FROM hc_sessions WHERE user_id=$1 AND token_hash<>$2",
        [a!.id, a!.tokenHash],
      );
      await tx.query(
        "UPDATE hc_sessions SET last_strong_auth=now() WHERE token_hash=$1",
        [a!.tokenHash],
      );
    });
    res.json({ success: true });
  });
  route("post", "/mfa/check", async (req, res, db, a) => {
    if (
      !a!.mfa_secret ||
      !validOtp(unseal(a!.mfa_secret, a!.id), req.body.code)
    )
      fail("Некоректний код", 401);
    await db.query(
      "UPDATE hc_sessions SET last_strong_auth=now() WHERE token_hash=$1",
      [a!.tokenHash],
    );
    res.json({ success: true });
  });
}
