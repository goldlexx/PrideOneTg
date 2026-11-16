/**
 * PRIDE ONE — API для Telegram Mini App (маршруты /api/*).
 *
 * Worker только проверяет подпись Telegram initData, членство родителя в группе филиала
 * и передаёт запрос Durable Object филиала. Правила записи и отмены — те же, что у бота
 * (src/branch-do.js: insertBooking, cancelBlockReason, applyCancel). Отдельного хранилища нет.
 *
 * Идентификатор родителя берётся ТОЛЬКО из проверенного initData. user id из тела запроса
 * не используется и не принимается.
 */

import { BRANCHES, TelegramError, parseBranchChats, tgCall } from "./branch-do.js";

const INIT_DATA_MAX_AGE_S = 24 * 3600;
const MAX_BODY_BYTES = 2048;
const MEMBER_TTL_MS = 5 * 60 * 1000;
const NON_MEMBER_TTL_MS = 30 * 1000;

const encoder = new TextEncoder();

/* ============================== initData ==================================== */

async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, typeof data === "string" ? encoder.encode(data) : data));
}

function toHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function equalHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Проверка подписи Telegram Web App initData (HMAC-SHA256 с ключом, выведенным из BOT_TOKEN).
 * Возвращает { ok: true, user: {id, name, first_name, ...} } или { ok: false, reason }.
 */
export async function verifyInitData(initData, botToken, nowMs = Date.now()) {
  if (!botToken) return { ok: false, reason: "not_configured" };
  if (typeof initData !== "string" || !initData || initData.length > 4096) return { ok: false, reason: "missing" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: "bad_hash" };

  const pairs = [];
  for (const [key, value] of params) if (key !== "hash") pairs.push(`${key}=${value}`);
  pairs.sort();

  const secret = await hmac(encoder.encode("WebAppData"), botToken);
  const expected = toHex(await hmac(secret, pairs.join("\n")));
  if (!equalHex(expected, hash)) return { ok: false, reason: "bad_signature" };

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, reason: "bad_auth_date" };
  const age = nowMs / 1000 - authDate;
  if (age > INIT_DATA_MAX_AGE_S || age < -300) return { ok: false, reason: "expired" };

  let user;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch (_) {
    user = null;
  }
  if (!user || !Number.isSafeInteger(Number(user.id))) return { ok: false, reason: "no_user" };

  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return { ok: true, user: { id: String(user.id), name, first_name: user.first_name || "" } };
}

/* ============================== членство ==================================== */

const memberCache = new Map();

/** Не удалось проверить членство из-за временной ошибки Telegram: пользователя нельзя считать посторонним. */
class MembershipCheckError extends Error {}

async function isGroupMember(env, chatId, userId) {
  const key = `${chatId}:${userId}`;
  const cached = memberCache.get(key);
  if (cached && cached.until > Date.now()) return cached.value;

  let value = false;

  try {
    const member = await tgCall(env.BOT_TOKEN, "getChatMember", { chat_id: chatId, user_id: Number(userId) });
    value =
      ["creator", "administrator", "member"].includes(member?.status) ||
      (member?.status === "restricted" && member?.is_member === true);
  } catch (error) {
    // Отсутствие в группе подтверждает только ответ Telegram «user not found». Сетевые ошибки, 429, 5xx
    // и прочие ответы (например, бот удалён из чата) — временный сбой: в кеш не пишем, отдаём 503.
    const description = String(error?.description || "");
    if (error instanceof TelegramError && !error.network && Number(error.code) === 400 &&
        /user not found|participant_id_invalid/i.test(description)) {
      value = false;
    } else {
      console.warn("miniapp getChatMember:", error?.message || error);
      throw new MembershipCheckError();
    }
  }

  if (memberCache.size > 2000) memberCache.clear();
  memberCache.set(key, { value, until: Date.now() + (value ? MEMBER_TTL_MS : NON_MEMBER_TTL_MS) });
  return value;
}

/* =============================== маршруты =================================== */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function fail(status, code, message) {
  return json({ ok: false, code, message }, status);
}

function branchStub(env, branchId) {
  return env.BRANCH_DO.get(env.BRANCH_DO.idFromName(branchId));
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("too_large");
  const data = text ? JSON.parse(text) : {};
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("bad_json");
  return data;
}

/** Филиалы, подключённые в BRANCH_CHATS и известные коду. Новый филиал появляется после настройки конфигурации. */
function connectedBranches(env) {
  return Object.entries(parseBranchChats(env)).map(([id, chatId]) => ({ id, chatId, name: BRANCHES[id].name }));
}

async function memberBranches(env, userId) {
  const all = connectedBranches(env);
  const checks = await Promise.all(all.map(b => isGroupMember(env, b.chatId, userId)));
  return all.filter((_, i) => checks[i]);
}

export function isMiniAppRoute(pathname) {
  return pathname.startsWith("/api/");
}

export async function handleMiniApp(request, env, ctx, url) {
  const route = `${request.method} ${url.pathname}`;
  const known = ["GET /api/branches", "GET /api/schedule", "GET /api/my", "POST /api/book", "POST /api/cancel"];
  if (!known.includes(route)) return fail(404, "not_found", "Не найдено.");

  const header = request.headers.get("Authorization") || "";
  const initData = header.startsWith("tma ") ? header.slice(4) : "";
  // Только для автотестов: env.TEST_NOW (как в Durable Object). В Cloudflare такой привязки нет.
  const nowMs = typeof env.TEST_NOW === "function" ? env.TEST_NOW() : Date.now();
  const auth = await verifyInitData(initData, env.BOT_TOKEN, nowMs);

  if (!auth.ok) {
    const message =
      auth.reason === "expired"
        ? "Сессия устарела. Закройте и снова откройте приложение из Telegram."
        : "Откройте приложение из Telegram.";
    return fail(auth.reason === "not_configured" ? 503 : 401, `auth_${auth.reason}`, message);
  }

  const user = auth.user;

  try {
    const branches = await memberBranches(env, user.id);

    if (route === "GET /api/branches") {
      return json({
        ok: true,
        user: { first_name: user.first_name },
        branches: branches.map(b => ({ id: b.id, name: b.name }))
      });
    }

    if (route === "GET /api/my") {
      const lists = await Promise.all(branches.map(b => branchStub(env, b.id).apiMyBookings(b.id, user)));
      const bookings = lists
        .flatMap(item => item.bookings)
        .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
      return json({ ok: true, bookings });
    }

    // Остальные маршруты привязаны к филиалу.
    let body = {};
    if (request.method === "POST") {
      try {
        body = await readBody(request);
      } catch (_) {
        return fail(400, "bad_request", "Некорректный запрос.");
      }
    }

    const branchId = String(request.method === "GET" ? url.searchParams.get("branch") : body.branch || "").toUpperCase();
    if (!branches.some(b => b.id === branchId)) {
      return fail(403, "branch_forbidden", "Этот филиал недоступен: вы не состоите в его группе.");
    }

    const stub = branchStub(env, branchId);

    if (route === "GET /api/schedule") {
      return json({ ok: true, ...(await stub.apiSchedule(branchId, user)) });
    }

    let result;

    if (route === "POST /api/book") {
      result = await stub.apiBook(branchId, user, {
        date: String(body.date || ""), time: String(body.time || ""), childName: String(body.child_name || "")
      });
    } else {
      result = await stub.apiCancel(branchId, user, String(body.booking_id || ""), { confirmLate: body.confirm_late === true });
    }

    if (result.enqueued) {
      // Сообщения в группу уходят после ответа; при сбое их выполнит будильник Durable Object.
      ctx.waitUntil(stub.drain(branchId).catch(error => console.error("drain failed:", error?.message || error)));
    }

    const { enqueued, ...publicResult } = result;
    return json(publicResult, result.ok ? 200 : 409);
  } catch (error) {
    if (error instanceof MembershipCheckError) {
      return fail(503, "telegram_unavailable", "Не удалось проверить участие в группе. Попробуйте ещё раз через несколько секунд.");
    }
    console.error("miniapp error:", error?.stack || error);
    return fail(500, "server_error", "Временная ошибка сервера. Попробуйте ещё раз.");
  }
}
