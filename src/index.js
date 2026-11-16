/**
 * PRIDE ONE Booking Bot — Worker (входная точка).
 *
 * Роль Worker намеренно узкая:
 *   1. принимает Telegram webhook и проверяет WEBHOOK_SECRET;
 *   2. определяет филиал по группе (BRANCH_CHATS) и передаёт update его Durable Object;
 *   3. проверяет права администратора для /init (getChatMember);
 *   4. отвечает на нажатие кнопки (answerCallbackQuery — короткая всплывающая подсказка);
 *   5. запускает отправку накопленных сообщений (drain) после ответа Telegram;
 *   6. обслуживает защищённые служебные эндпоинты /admin/*.
 *
 * Все данные о записях и все сообщения в группу — в Durable Object (src/branch-do.js).
 */

import {
  BranchBookingDO,
  BRANCHES,
  VERSION,
  branchForChat,
  botIdFromToken,
  parseBranchChats,
  parseInitCommand,
  tgCall
} from "./branch-do.js";

import { handleMiniApp, isMiniAppRoute } from "./miniapp.js";

export { BranchBookingDO };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if ((url.pathname === "/" || url.pathname === "/health") && request.method === "GET") {
      return json({ ok: true, worker: "pride-one-bot", version: VERSION });
    }

    if (url.pathname === "/webhook") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
      return handleWebhook(request, env, ctx);
    }

    if (isMiniAppRoute(url.pathname)) {
      return handleMiniApp(request, env, ctx, url);
    }

    if (url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env, ctx, url);
    }

    return json({ ok: false, error: "Not found" }, 404);
  },

  // Ежечасная страховка (Cron Trigger): будит объекты филиалов, чтобы панель
  // перерисовывалась даже без активности в группе.
  async scheduled(_event, env, ctx) {
    for (const branchId of Object.keys(parseBranchChats(env))) {
      ctx.waitUntil(
        branchStub(env, branchId).tick(branchId).catch(error => console.error("tick failed:", branchId, error?.message || error))
      );
    }
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

/**
 * Production webhook живёт на *.workers.dev. Адрес берётся из WEBHOOK_URL, если он задан, иначе —
 * из текущего хоста, но только если это workers.dev. Вызов через другой домен (booking.prideone.ru и т.п.)
 * webhook не переключает.
 */
function expectedWebhookUrl(env, url) {
  if (env.WEBHOOK_URL) return String(env.WEBHOOK_URL);
  return url.hostname.endsWith(".workers.dev") ? `${url.origin}/webhook` : null;
}

function branchStub(env, branchId) {
  return env.BRANCH_DO.get(env.BRANCH_DO.idFromName(branchId));
}

function safeEqual(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  if (!x || !y || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/* ================================ WEBHOOK ================================== */

async function handleWebhook(request, env, ctx) {
  if (!env.WEBHOOK_SECRET || !env.BOT_TOKEN) {
    return json({ ok: false, error: "Bot is not configured" }, 503);
  }

  if (!safeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), env.WEBHOOK_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let update;

  try {
    update = await request.json();
  } catch (_) {
    return json({ ok: true, ignored: "invalid json" });
  }

  if (!Number.isSafeInteger(Number(update?.update_id))) {
    return json({ ok: true, ignored: "no update_id" });
  }

  const message = update.message;
  const callback = update.callback_query;
  const chat = message?.chat || callback?.message?.chat;

  if (!chat) return json({ ok: true, ignored: "unsupported update" });

  let branchId = branchForChat(env, chat.id);
  const init = message ? parseInitCommand(message.text) : null;

  // /init из чужой группы или из личного чата тоже передаём объекту филиала,
  // чтобы он ответил, почему панель не будет опубликована.
  if (!branchId && init && BRANCHES[init.branchArg]) branchId = init.branchArg;
  if (!branchId) {
    if (callback?.id) {
      try {
        await tgCall(env.BOT_TOKEN, "answerCallbackQuery", {
          callback_query_id: callback.id, text: "Кнопка недоступна в этом чате.", show_alert: true
        });
      } catch (_) {
        // не критично
      }
    }
    return json({ ok: true, ignored: "chat is not connected" });
  }

  const meta = { isAdmin: false };

  if (init && (chat.type === "group" || chat.type === "supergroup")) {
    meta.isAdmin = await isChatAdmin(env, message);
  }

  let result;

  try {
    result = await branchStub(env, branchId).handleUpdate(branchId, update, meta);
  } catch (error) {
    // Транзакция в Durable Object откатилась целиком. Отвечаем 500 — Telegram
    // повторит update, и благодаря проверке update_id повтор безопасен.
    console.error("handleUpdate failed:", update.update_id, error?.stack || error);
    return json({ ok: false, error: "temporary failure" }, 500);
  }

  if (callback?.id) {
    const answer = result?.answer || {};
    try {
      const payload = { callback_query_id: callback.id };
      if (answer.text) payload.text = answer.text;
      if (answer.alert) payload.show_alert = true;
      await tgCall(env.BOT_TOKEN, "answerCallbackQuery", payload);
    } catch (error) {
      // Подсказка у кнопки не критична: данные уже сохранены.
      console.warn("answerCallbackQuery:", error?.message || error);
    }
  }

  if (result?.enqueued) {
    // Отправка сообщений — после ответа Telegram. Если Worker прервётся,
    // задачи останутся в outbox и их выполнит будильник Durable Object.
    ctx.waitUntil(
      branchStub(env, branchId).drain(branchId).catch(error => console.error("drain failed:", error?.message || error))
    );
  }

  return json({ ok: true, duplicate: !!result?.duplicate });
}

async function isChatAdmin(env, message) {
  // Анонимный администратор пишет от имени самой группы.
  if (message.sender_chat?.id && String(message.sender_chat.id) === String(message.chat.id)) return true;
  if (!message.from?.id) return false;

  try {
    const member = await tgCall(env.BOT_TOKEN, "getChatMember", {
      chat_id: message.chat.id,
      user_id: message.from.id
    });
    return member?.status === "creator" || member?.status === "administrator";
  } catch (error) {
    console.warn("getChatMember:", error?.message || error);
    return false;
  }
}

/* ================================= ADMIN =================================== */

async function handleAdmin(request, env, ctx, url) {
  if (!env.ADMIN_SECRET || String(env.ADMIN_SECRET).length < 16) {
    return json({ ok: false, error: "ADMIN_SECRET is not configured (min 16 characters)" }, 503);
  }

  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!safeEqual(token, env.ADMIN_SECRET)) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const branchId = (url.searchParams.get("branch") || "P03").toUpperCase();
  if (!BRANCHES[branchId]) return json({ ok: false, error: "Unknown branch" }, 400);

  const route = `${request.method} ${url.pathname}`;

  try {
    switch (route) {
      case "GET /admin/status":
        return json({ ok: true, branch_chats: parseBranchChats(env), status: await branchStub(env, branchId).status(branchId) });

      case "GET /admin/webhook": {
        // Только чтение: текущее состояние webhook в Telegram.
        const info = await tgCall(env.BOT_TOKEN, "getWebhookInfo", {});
        return json({
          ok: true,
          expected_url: expectedWebhookUrl(env, url),
          webhook: {
            url: info.url,
            url_matches: expectedWebhookUrl(env, url) ? info.url === expectedWebhookUrl(env, url) : null,
            pending_update_count: info.pending_update_count,
            max_connections: info.max_connections,
            allowed_updates: info.allowed_updates || null,
            last_error_date: info.last_error_date || null,
            last_error_message: info.last_error_message || null
          }
        });
      }

      case "POST /admin/webhook": {
        if (!env.WEBHOOK_SECRET || !env.BOT_TOKEN) return json({ ok: false, error: "BOT_TOKEN / WEBHOOK_SECRET missing" }, 503);
        const target = expectedWebhookUrl(env, url);
        if (!target) {
          // Защита от случайного переключения: webhook ставится только на workers.dev (или на WEBHOOK_URL).
          return json({ ok: false, error: "Webhook можно менять только с адреса *.workers.dev или при заданной переменной WEBHOOK_URL" }, 409);
        }
        const result = await tgCall(env.BOT_TOKEN, "setWebhook", {
          url: target,
          secret_token: env.WEBHOOK_SECRET,
          allowed_updates: ["message", "callback_query"],
          drop_pending_updates: false
        });
        const info = await tgCall(env.BOT_TOKEN, "getWebhookInfo", {});
        return json({
          ok: true,
          result,
          webhook: {
            url: info.url,
            pending_update_count: info.pending_update_count,
            max_connections: info.max_connections,
            last_error_message: info.last_error_message || null
          }
        });
      }

      case "POST /admin/migrate": {
        const dryRun = url.searchParams.get("dry_run") !== "0";
        const force = url.searchParams.get("force") === "1";
        const snapshot = await readLegacyKv(env, branchId);
        const result = await branchStub(env, branchId).importLegacy(branchId, snapshot, { dryRun, force });
        if (result?.applied) ctx.waitUntil(branchStub(env, branchId).drain(branchId).catch(() => {}));
        return json({ dry_run: dryRun, ...result }, result.ok ? 200 : 409);
      }

      case "POST /admin/drain":
        return json({ ok: true, outbox: await branchStub(env, branchId).drain(branchId) });

      default:
        return json({ ok: false, error: "Not found" }, 404);
    }
  } catch (error) {
    console.error("admin error:", error?.stack || error);
    return json({ ok: false, error: String(error?.message || error) }, 500);
  }
}

/**
 * Читает старые данные из KV (только чтение — ничего не удаляет и не меняет).
 */
async function readLegacyKv(env, branchId) {
  if (!env.PRIDE_KV) throw new Error("KV binding PRIDE_KV is not configured");

  const kv = env.PRIDE_KV;

  async function listAll(prefix) {
    const names = [];
    let cursor;

    do {
      const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
      for (const key of page.keys || []) names.push(key.name);
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);

    return names;
  }

  async function readMany(prefix) {
    const out = {};
    for (const name of await listAll(prefix)) {
      const raw = await kv.get(name);
      if (raw === null) continue;
      try {
        out[name] = JSON.parse(raw);
      } catch (_) {
        out[name] = raw;
      }
    }
    return out;
  }

  const snapshot = {
    sessions: await readMany(`session:${branchId}:`),
    bookings: await readMany("booking:"),
    parents: await readMany("parent:"),
    days: await readMany(`day:${branchId}:`),
    dayboards: await readMany(`dayboard:${branchId}:`),
    branch: null
  };

  const branchRaw = await kv.get(`branch:${branchId}`);
  if (branchRaw !== null) {
    try {
      snapshot.branch = JSON.parse(branchRaw);
    } catch (_) {
      snapshot.branch = null;
    }
  }

  snapshot.keyCounts = {
    [`session:${branchId}:*`]: Object.keys(snapshot.sessions).length,
    "booking:*": Object.keys(snapshot.bookings).length,
    "parent:*": Object.keys(snapshot.parents).length,
    [`day:${branchId}:*`]: Object.keys(snapshot.days).length,
    [`dayboard:${branchId}:*`]: Object.keys(snapshot.dayboards).length,
    [`branch:${branchId}`]: snapshot.branch ? 1 : 0
  };

  return snapshot;
}

// Экспорт для автотестов.
export const _internal = { readLegacyKv, botIdFromToken };
