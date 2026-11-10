import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import * as OTPAuth from "otpauth";
import nodemailer from "nodemailer";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { accountExport, deleteAccountData } from "./accountData";
import { consumeExportTicket, issueExportTicket } from "./exportTickets";
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
  uuid,
} from "./security";
import { mergeProfileUpdate } from "../../src/utils/hookchartData";
import { claimProfileName, ownProfileName } from "./profileNames";

import { accountFor, type Account } from "./session";
import {
  consumeFactor,
  matchesPassword,
  passwordHashOptions,
  replaceRecoveryCodes,
  securityNotice,
  totpCounter,
  withCredentials,
  type CredentialAccount,
} from "./credentials";
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
  res: Response | undefined,
  strong: boolean,
) {
  const token = opaqueToken();
  await db.query(
    `INSERT INTO hc_sessions(token_hash,user_id,expires_at,last_strong_auth) VALUES($1,$2,now()+interval '7 days',$3)`,
    [tokenHash(token), userId, strong ? new Date() : null],
  );
  if (res) setSessionCookie(res, token);
  return token;
}
function setSessionCookie(res: Response, token: string) {
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
  clock: () => number = Date.now,
) {
  const limits = new RequestLimits();
  let passwordOperations = 0;
  const exports = new Set<string>();
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
        if (method !== "get" &&
          [
            "/register",
            "/login",
            "/reset",
            "/mfa/setup",
            "/mfa/recovery-codes",
            "/mfa/disable",
            "/password",
            "/export",
            "/delete",
            "/username",
          ].includes(path)
        ) {
          if (passwordOperations >= 2)
            fail("Сервіс входу зайнятий. Повторіть запит.", 503);
          passwordOperations++;
          hashSlot = true;
        }
        const db = getDb(),
          account = await accountFor(db, req);
        if (auth && !account) fail("Увійдіть у свій акаунт", 401);
        if (
          method !== "get" && account &&
          [
            "/mfa/setup",
            "/mfa/confirm",
            "/mfa/check",
            "/mfa/recovery-codes",
            "/mfa/disable",
            "/export",
            "/delete",
            "/password",
            "/username",
          ].includes(path)
        )
          limits.take("sensitive:" + account.id + ":" + path, 10, 900_000);
        await run(req, res, db, account);
      } catch (error: any) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
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
        ...(a
          ? {
              ...present(a),
              security: {
                ...present(a).security,
                recoveryCodesRemaining: Number(
                  (
                    await _db.query(
                      "SELECT count(*)::integer AS count FROM hc_recovery_codes WHERE user_id=$1 AND used_at IS NULL",
                      [a.id],
                    )
                  ).rows[0].count,
                ),
              },
            }
          : { user: null, profile: null }),
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
      const { rows } = await db.query<CredentialAccount>(
        "SELECT * FROM hc_users WHERE email=$1 AND deleted_at IS NULL",
        [email],
      );
      const initial = rows[0];
      const good = await matchesPassword(
        initial?.password_hash,
        req.body.password,
      );
      if (!initial || !good) fail("Неправильний email або пароль", 401);
      const result = await db.transaction(async (tx) => {
        const locked = await tx.query<CredentialAccount>(
          "SELECT * FROM hc_users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
          [initial.id],
        );
        const user = locked.rows[0];
        if (!user || user.password_hash !== initial.password_hash)
          fail("Дані входу змінилися. Повторіть вхід.", 401);
        if (user.mfa_secret) await consumeFactor(tx, user, req.body, clock());
        const token = await newSession(
          tx,
          user.id,
          undefined,
          !!user.mfa_secret,
        );
        return { user, token };
      });
      setSessionCookie(res, result.token);
      res.json({
        success: true,
        ...present({
          ...result.user,
          strong: !!result.user.mfa_secret,
          tokenHash: "",
        }),
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
  route("post", "/export", async (req, res, db, a) => {
    limits.take("export:" + a!.id, 5, 3600_000);
    const scope = req.body.scope ?? "community";
    if (!["community", "market"].includes(scope))
      fail("Невідомий тип експорту");
    const ticket = await withCredentials(
      db,
      a!,
      req.body,
      (tx) => issueExportTicket(tx, a!, scope),
      clock(),
    );
    res.json({
      success: true,
      url:
        (scope === "market"
          ? "/api/user-data/export/"
          : "/api/account/export/") + ticket,
      expiresInSeconds: 600,
    });
  });
  route("get", "/export/:ticket", async (req, res, db, a) => {
    if (req.method !== "GET") {
      res.set("Allow", "GET").status(405).end();
      return;
    }
    if (exports.size >= 2 || exports.has(a!.id))
      fail("Інший експорт ще триває. Повторіть пізніше.", 429);
    exports.add(a!.id);
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once("close", close);
    const timer = setTimeout(close, 300_000);
    timer.unref();
    try {
      await consumeExportTicket(db, a!, req.params.ticket, "community");
      res.set({
        "Content-Type": "application/gzip",
        "Content-Disposition":
          'attachment; filename="h00k-community-' +
          new Date().toISOString().slice(0, 10) +
          '.jsonl.gz"',
        "Referrer-Policy": "no-referrer",
      });
      await pipeline(
        Readable.from(accountExport(db, a!, controller.signal)),
        createGzip(),
        res,
      );
    } finally {
      clearTimeout(timer);
      res.off("close", close);
      exports.delete(a!.id);
    }
  });
  route("get", "/delete/preview", async (_req, res, db, a) => {
    const { rows } = await db.query(
      `SELECT
      (SELECT count(*)::integer FROM hc_items WHERE owner_id=$1 AND NOT deleted) AS items,
      (SELECT count(*)::integer FROM hc_archives WHERE owner_id=$1) AS archives,
      (SELECT count(*)::integer FROM hc_trades WHERE owner_id=$1) AS trades,
      (SELECT count(*)::integer FROM hc_media WHERE owner_id=$1) AS media,
      (SELECT count(*)::integer FROM hc_conversations WHERE owner_id=$1 AND EXISTS(SELECT 1 FROM hc_members WHERE conversation_id=hc_conversations.id AND user_id<>$1)) AS groups`,
      [a!.id],
    );
    res.json({
      success: true,
      counts: rows[0],
      policy:
        "Own content and keys are erased; groups pass to the oldest admin/member. Market records and media files use a durable cleanup queue. Previously downloaded copies and backups require separate retention procedures.",
    });
  });
  route("post", "/delete", async (req, res, db, a) => {
    if (req.body.confirm !== "DELETE")
      fail("Введіть DELETE для підтвердження видалення");
    await withCredentials(
      db,
      a!,
      req.body,
      (tx, user) => deleteAccountData(tx, user.id),
      clock(),
    );
    res.clearCookie("h00k_session", { path: "/" });
    res.json({ success: true, deleted: true, backgroundCleanup: "queued" });
  });
  route("get", "/username", async (_req, res, db, a) => {
    res.json({ success: true, emailVerified: a!.email_verified, ...(await ownProfileName(db, a!.id)) });
  });
  route("post", "/username", async (req, res, db, a) => {
    const result = await withCredentials(db, a!, req.body, async (tx, user) => {
      if (!user.email_verified) fail("Спочатку підтвердіть email", 403);
      return claimProfileName(tx, user.id, req.body.username, clock());
    }, clock());
    res.json({ success: true, emailVerified: a!.email_verified, ...result });
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
      "username",
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
      if (raw.publicProfileEnabled !== undefined) {
        if (typeof raw.publicProfileEnabled !== "boolean") fail("Некоректна видимість профілю");
        clean.publicProfileEnabled = raw.publicProfileEnabled;
      }
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
        "SELECT profile FROM hc_users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
        [a!.id],
      );
      if (!rows.length) fail("Сеанс акаунта закінчився", 401);
      if (patch.community?.publicProfileEnabled === true) {
        const name = await tx.query("SELECT username FROM hc_profile_names WHERE owner_id=$1", [a!.id]);
        if (!name.rows.length) fail("Спочатку зарезервуйте персональну адресу", 409);
      }
      const merged = mergeProfileUpdate(
        { ...rows[0].profile, uid: a!.id },
        patch,
      );
      if (patch.community) merged.community = { ...rows[0].profile.community, ...patch.community };
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
    await db.transaction(async (tx) => {
      const active = await tx.query(
        "SELECT id FROM hc_users WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
        [a!.id],
      );
      if (!active.rows.length) fail("Акаунт недоступний", 401);
      await tx.query(
        `INSERT INTO hc_tokens(token_hash,user_id,purpose,expires_at) VALUES($1,$2,'verify',now()+interval '30 minutes')`,
        [tokenHash(token), a!.id],
      );
    });
    try {
      await mail(
        a!.email,
        "Підтвердження email h00k",
        `${process.env.APP_ORIGIN}/?verify=${token}#community?section=settings`,
      );
    } catch (error) {
      await db.query("DELETE FROM hc_tokens WHERE token_hash=$1", [
        tokenHash(token),
      ]);
      throw error;
    }
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
        await tx.query(
          "UPDATE hc_users SET email_verified=true WHERE id=$1 AND deleted_at IS NULL",
          [rows[0].user_id],
        );
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
        "SELECT id,email FROM hc_users WHERE email=$1 AND deleted_at IS NULL",
        [email],
      );
      if (rows.length) {
        const token = opaqueToken();
        try {
          const queued = await db.transaction(async (tx) => {
            const active = await tx.query(
              "SELECT id FROM hc_users WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
              [rows[0].id],
            );
            if (!active.rows.length) return false;
            await tx.query(
              `INSERT INTO hc_tokens(token_hash,user_id,purpose,expires_at) VALUES($1,$2,'reset',now()+interval '15 minutes')`,
              [tokenHash(token), rows[0].id],
            );
            return true;
          });
          if (queued)
            void mail(
              email,
              "Відновлення доступу h00k",
              `${process.env.APP_ORIGIN}/?reset=${token}`,
            ).catch(() =>
              console.warn("Account recovery delivery unavailable"),
            );
        } catch {
          console.warn("Account recovery delivery unavailable");
        }
      }
      res.json({
        success: true,
        message: "Якщо акаунт існує, інструкція надійде на email.",
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
      const token = tokenHash(bounded(req.body.token, 100));
      const found = await db.query(
        "SELECT user_id FROM hc_tokens WHERE token_hash=$1 AND purpose='reset' AND expires_at>now()",
        [token],
      );
      if (!found.rows.length) fail("Посилання недійсне або прострочене");
      await db.transaction(async (tx) => {
        const current = await tx.query<CredentialAccount>(
          "SELECT * FROM hc_users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
          [found.rows[0].user_id],
        );
        const user = current.rows[0];
        const available = await tx.query(
          "SELECT token_hash FROM hc_tokens WHERE token_hash=$1 AND user_id=$2 AND purpose='reset' AND expires_at>now() FOR UPDATE",
          [token, found.rows[0].user_id],
        );
        if (!user || !available.rows.length)
          fail("Посилання недійсне або прострочене");
        if (user.mfa_secret) await consumeFactor(tx, user, req.body, clock());
        await tx.query(
          "UPDATE hc_users SET password_hash=$2,mfa_pending=NULL WHERE id=$1",
          [user.id, hash],
        );
        await tx.query("DELETE FROM hc_tokens WHERE user_id=$1", [user.id]);
        await tx.query("DELETE FROM hc_sessions WHERE user_id=$1", [user.id]);
        await securityNotice(
          tx,
          user.id,
          "password-reset",
          "Пароль відновлено. Попередні сеанси відкликано.",
        );
      });
      res.clearCookie("h00k_session", { path: "/" });
      res.json({ success: true });
    },
    false,
  );
  route("get", "/sessions", async (_req, res, db, a) => {
    const { rows } = await db.query(
      "SELECT id,created_at,expires_at,token_hash=$2 AS current FROM hc_sessions WHERE user_id=$1 AND expires_at>now() ORDER BY created_at DESC LIMIT 50",
      [a!.id, a!.tokenHash],
    );
    res.json({ success: true, items: rows });
  });
  route("delete", "/sessions/:id", async (req, res, db, a) => {
    const result = await db.query(
      "DELETE FROM hc_sessions WHERE user_id=$1 AND id=$2 RETURNING token_hash",
      [a!.id, uuid(req.params.id)],
    );
    if (!result.rows.length) fail("Сеанс недоступний", 404);
    if (result.rows[0].token_hash === a!.tokenHash)
      res.clearCookie("h00k_session", { path: "/" });
    res.json({ success: true });
  });
  route("post", "/password", async (req, res, db, a) => {
    const hash = await argon2.hash(
      password(req.body.newPassword),
      passwordHashOptions,
    );
    const token = await withCredentials(
      db,
      a!,
      req.body,
      async (tx, user) => {
        await tx.query(
          "UPDATE hc_users SET password_hash=$2,mfa_pending=NULL WHERE id=$1",
          [user.id, hash],
        );
        await tx.query("DELETE FROM hc_tokens WHERE user_id=$1", [user.id]);
        await tx.query("DELETE FROM hc_sessions WHERE user_id=$1", [user.id]);
        await securityNotice(
          tx,
          user.id,
          "password-changed",
          "Пароль змінено. Інші сеанси відкликано.",
        );
        return newSession(tx, user.id, undefined, !!user.mfa_secret);
      },
      clock(),
    );
    setSessionCookie(res, token);
    res.json({ success: true });
  });
  route("post", "/mfa/setup", async (req, res, db, a) => {
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    await withCredentials(
      db,
      a!,
      req.body,
      async (tx, user) => {
        const pending = {
          secret,
          expires: clock() + 900_000,
          sessionHash: a!.tokenHash,
          factorHash: tokenHash(user.mfa_secret ?? ""),
        };
        await tx.query("UPDATE hc_users SET mfa_pending=$2 WHERE id=$1", [
          user.id,
          seal(JSON.stringify(pending), user.id),
        ]);
      },
      clock(),
    );
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
    const codes = await db.transaction(async (tx) => {
      const { rows } = await tx.query<CredentialAccount>(
        `SELECT u.* FROM hc_users u JOIN hc_sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.token_hash=$2 AND s.expires_at>now() AND u.deleted_at IS NULL FOR UPDATE OF u FOR SHARE OF s`,
        [a!.id, a!.tokenHash],
      );
      const user = rows[0];
      if (!user?.mfa_pending) fail("Спочатку налаштуйте другий фактор");
      const pending = JSON.parse(unseal(user.mfa_pending, user.id));
      if (
        pending.expires < clock() ||
        pending.sessionHash !== a!.tokenHash ||
        pending.factorHash !== tokenHash(user.mfa_secret ?? "")
      )
        fail("Налаштування прострочене або належить іншому сеансу", 403);
      const counter = totpCounter(pending.secret, req.body.code, clock());
      if (counter === null) fail("Некоректний код 2FA");
      await tx.query(
        "UPDATE hc_users SET mfa_secret=$2,mfa_pending=NULL,mfa_last_counter=$3 WHERE id=$1",
        [user.id, seal(pending.secret, user.id), counter],
      );
      await tx.query(
        "DELETE FROM hc_sessions WHERE user_id=$1 AND token_hash<>$2",
        [user.id, a!.tokenHash],
      );
      await tx.query(
        "UPDATE hc_sessions SET last_strong_auth=now() WHERE token_hash=$1",
        [a!.tokenHash],
      );
      await securityNotice(
        tx,
        user.id,
        "mfa-enabled",
        "Другий фактор налаштовано. Інші сеанси відкликано. Збережіть резервні коди окремо від пароля.",
      );
      return replaceRecoveryCodes(tx, user.id);
    });
    res.json({ success: true, recoveryCodes: codes });
  });
  route("post", "/mfa/check", async (req, res, db, a) => {
    await db.transaction(async (tx) => {
      const current = await tx.query<CredentialAccount>(
        `SELECT u.* FROM hc_users u JOIN hc_sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.token_hash=$2 AND s.expires_at>now() AND u.deleted_at IS NULL FOR UPDATE OF u FOR SHARE OF s`,
        [a!.id, a!.tokenHash],
      );
      if (!current.rows[0]) fail("Увійдіть знову", 401);
      await consumeFactor(tx, current.rows[0], req.body, clock());
      await tx.query(
        "UPDATE hc_sessions SET last_strong_auth=now() WHERE token_hash=$1",
        [a!.tokenHash],
      );
    });
    res.json({ success: true });
  });
  route("post", "/mfa/recovery-codes", async (req, res, db, a) => {
    const codes = await withCredentials(
      db,
      a!,
      req.body,
      async (tx, user) => {
        if (!user.mfa_secret) fail("Спочатку налаштуйте другий фактор", 403);
        const result = await replaceRecoveryCodes(tx, user.id);
        await securityNotice(
          tx,
          user.id,
          "recovery-codes-replaced",
          "Резервні коди замінено. Попередній набір більше не діє.",
        );
        return result;
      },
      clock(),
    );
    res.json({ success: true, recoveryCodes: codes });
  });
  route("post", "/mfa/disable", async (req, res, db, a) => {
    await withCredentials(
      db,
      a!,
      req.body,
      async (tx, user) => {
        if (!user.mfa_secret) fail("Другий фактор не налаштовано");
        await tx.query(
          "UPDATE hc_users SET mfa_secret=NULL,mfa_pending=NULL,mfa_last_counter=-1 WHERE id=$1",
          [user.id],
        );
        await tx.query("DELETE FROM hc_recovery_codes WHERE user_id=$1", [
          user.id,
        ]);
        await tx.query(
          "DELETE FROM hc_sessions WHERE user_id=$1 AND token_hash<>$2",
          [user.id, a!.tokenHash],
        );
        await tx.query(
          "UPDATE hc_sessions SET last_strong_auth=NULL WHERE token_hash=$1",
          [a!.tokenHash],
        );
        await securityNotice(
          tx,
          user.id,
          "mfa-disabled",
          "Другий фактор вимкнено. Інші сеанси та резервні коди відкликано.",
        );
      },
      clock(),
    );
    res.json({ success: true });
  });
}
