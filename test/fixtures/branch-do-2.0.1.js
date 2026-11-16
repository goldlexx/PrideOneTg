// Замороженная копия src/branch-do.js версии 2.0.1 — ТОЛЬКО для тестов обновления и отката (test/upgrade.test.mjs). Не редактировать.
/**
 * PRIDE ONE Booking Bot — Durable Object филиала (SQLite).
 *
 * Один объект на филиал (idFromName("P03")). Объект — единственный владелец данных
 * о записях: все изменения выполняются синхронно внутри ctx.storage.transactionSync(),
 * без await между чтением и записью, поэтому параллельные запросы не могут
 * вклиниться в середину операции, а SQLite откатывает операцию целиком при ошибке.
 *
 * Сообщения в Telegram отправляются только через таблицу outbox:
 *   бизнес-транзакция кладёт в outbox «намерение» (обновить список дня, отправить
 *   подтверждение...) в той же транзакции, что и изменение данных;
 *   исполнитель outbox (drainOutbox) отправляет их позже с повторами и бэкоффом;
 *   тексты списков и панели строятся в момент отправки из актуальных данных SQLite.
 */

import { DurableObject } from "cloudflare:workers";

/* ================================ НАСТРОЙКИ ================================ */

export const VERSION = "2.0.1";
export const TZ = "Europe/Moscow";
export const PAGE_COUNT = 4;

// Подтверждённое расписание. 0 — воскресенье, 2 — вторник, 4 — четверг.
// Новый филиал = новая запись здесь + его группа в BRANCH_CHATS.
export const BRANCHES = Object.freeze({
  P03: {
    id: "P03",
    name: "Пролетарская",
    schedule: { 2: ["18:00", "19:00"], 4: ["18:00", "19:00"], 0: ["12:00", "13:00"] }
  }
});

const PROMPT_TTL_MS = 20 * 60 * 1000;
const PROMPT_REUSE_MS = 2 * 60 * 1000;
const OUTBOX_LEASE_MS = 60 * 1000;
const OUTBOX_MAX_ATTEMPTS = 12;
const OUTBOX_BATCH = 100;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 10 * 60 * 1000;
const HOUSEKEEPING_MS = 60 * 60 * 1000;
const KEEP_UPDATES_MS = 7 * 24 * 3600 * 1000;
const KEEP_OUTBOX_DONE_MS = 3 * 24 * 3600 * 1000;
const SAFETY_ALARM_MS = 5000;
const MAX_LIST_ITEMS = 30;

export const PROMPT_MARK = "Ответьте на это сообщение именем ребёнка";
export const MY_LIST_HEADER = "PRIDE ONE | МОИ ЗАПИСИ";
export const CONFIRM_HEADER = "Запись подтверждена.";
export const BOARD_HEADER = "PRIDE ONE | ЗАПИСЬ НА ДЕНЬ";
export const PANEL_HEADER = "PRIDE ONE | ЗАПИСЬ";
const MIGRATION_META_KEY = "migration:kv_v1";

const PRIORITY = { urgent: 0, board: 1, panel: 2, cleanup: 3 };

/* ================================ СХЕМА SQLITE ============================= */

const SCHEMA_VERSION = "1";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  // Брони. Отмена не удаляет строку, а меняет status (история сохраняется).
  `CREATE TABLE IF NOT EXISTS bookings (
     id                    TEXT PRIMARY KEY,
     branch_id             TEXT NOT NULL,
     date                  TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
     time                  TEXT NOT NULL CHECK (time GLOB '[0-9][0-9]:[0-9][0-9]'),
     child_name            TEXT NOT NULL CHECK (length(child_name) BETWEEN 1 AND 80),
     normalized_child_name TEXT NOT NULL CHECK (length(normalized_child_name) >= 1),
     parent_id             TEXT NOT NULL CHECK (length(parent_id) >= 1),
     parent_name           TEXT NOT NULL DEFAULT '',
     status                TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
     source                TEXT NOT NULL DEFAULT 'bot' CHECK (source IN ('bot', 'legacy_kv')),
     prompt_id             INTEGER UNIQUE,
     created_at            INTEGER NOT NULL,
     cancelled_at          INTEGER,
     cancelled_by          TEXT,
     CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
   )`,
  // Главное правило: один родитель не может иметь две активные брони одного ребёнка на один слот.
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_bookings_active_child
     ON bookings (branch_id, date, time, parent_id, normalized_child_name)
     WHERE status = 'active'`,
  `CREATE INDEX IF NOT EXISTS ix_bookings_slot ON bookings (branch_id, date, time, status)`,
  `CREATE INDEX IF NOT EXISTS ix_bookings_parent ON bookings (parent_id, status, date)`,

  // История: создание, отмена, импорт.
  `CREATE TABLE IF NOT EXISTS booking_events (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     booking_id TEXT NOT NULL,
     event      TEXT NOT NULL CHECK (event IN ('created', 'cancelled', 'imported')),
     actor_id   TEXT,
     update_id  INTEGER,
     at         INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS ix_booking_events_booking ON booking_events (booking_id)`,

  // Формы «ответьте именем ребёнка».
  `CREATE TABLE IF NOT EXISTS pending_prompts (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     branch_id         TEXT NOT NULL,
     chat_id           TEXT NOT NULL,
     prompt_message_id INTEGER,
     parent_id         TEXT NOT NULL,
     parent_name       TEXT NOT NULL DEFAULT '',
     date              TEXT NOT NULL,
     time              TEXT NOT NULL,
     status            TEXT NOT NULL CHECK (status IN ('open', 'used', 'expired', 'closed')),
     booking_id        TEXT,
     created_at        INTEGER NOT NULL,
     expires_at        INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_prompts_message
     ON pending_prompts (chat_id, prompt_message_id) WHERE prompt_message_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ix_prompts_open ON pending_prompts (status, expires_at)`,
  `CREATE INDEX IF NOT EXISTS ix_prompts_parent_slot ON pending_prompts (parent_id, date, time, status)`,

  // Обработанные Telegram updates. Запись делается в той же транзакции, что и бизнес-изменение.
  `CREATE TABLE IF NOT EXISTS telegram_updates (
     update_id         INTEGER PRIMARY KEY,
     kind              TEXT NOT NULL,
     processing_status TEXT NOT NULL CHECK (processing_status IN ('done', 'ignored')),
     result            TEXT,
     processed_at      INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS ix_updates_time ON telegram_updates (processed_at)`,

  // Служебные сообщения бота: основная панель, общий список дня, подтверждения.
  `CREATE TABLE IF NOT EXISTS telegram_messages (
     kind          TEXT NOT NULL CHECK (kind IN ('panel', 'day_board', 'confirmation')),
     ref           TEXT NOT NULL,
     chat_id       TEXT NOT NULL,
     message_id    INTEGER NOT NULL,
     page          INTEGER NOT NULL DEFAULT 0,
     rendered_hash TEXT NOT NULL DEFAULT '',
     updated_at    INTEGER NOT NULL,
     PRIMARY KEY (kind, ref)
   )`,

  // Номер версии данных дня: растёт при каждой записи и отмене.
  `CREATE TABLE IF NOT EXISTS day_state (
     date     TEXT PRIMARY KEY,
     revision INTEGER NOT NULL
   )`,

  // Outbox: «что нужно сделать в Telegram». Пишется в одной транзакции с данными.
  `CREATE TABLE IF NOT EXISTS outbox (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     event_type      TEXT NOT NULL,
     dedupe_key      TEXT,
     payload         TEXT NOT NULL CHECK (json_valid(payload)),
     priority        INTEGER NOT NULL DEFAULT 1,
     status          TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'done', 'failed')),
     attempts        INTEGER NOT NULL DEFAULT 0,
     next_attempt_at INTEGER NOT NULL,
     lease_until     INTEGER,
     last_error      TEXT,
     created_at      INTEGER NOT NULL,
     updated_at      INTEGER NOT NULL
   )`,
  // Не больше одной ожидающей задачи с тем же ключом: «обновить список дня» схлопывается.
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_outbox_pending_key
     ON outbox (dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS ix_outbox_due ON outbox (status, priority, next_attempt_at, id)`
];

/* ============================== КОНФИГУРАЦИЯ ================================ */

export function parseBranchChats(env) {
  let raw = {};

  try {
    raw = JSON.parse(env?.BRANCH_CHATS || "{}");
  } catch (_) {
    raw = {};
  }

  const result = {};

  for (const [branchId, chatId] of Object.entries(raw || {})) {
    const value = String(chatId ?? "").trim();
    if (BRANCHES[branchId] && /^-\d+$/.test(value)) result[branchId] = value;
  }

  return result;
}

export function branchForChat(env, chatId) {
  for (const [branchId, value] of Object.entries(parseBranchChats(env))) {
    if (value === String(chatId)) return branchId;
  }
  return null;
}

export function botIdFromToken(token) {
  const id = String(token || "").split(":")[0];
  return /^\d+$/.test(id) ? id : null;
}

export function parseInitCommand(text) {
  const match = String(text || "").trim().match(/^\/init(?:@\w+)?(?:\s+(\S+))?\s*$/i);
  return match ? { branchArg: String(match[1] || "").toUpperCase() } : null;
}

/* ================================== ДАТЫ ===================================== */

const WEEKDAY_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

export function todayMoscow(nowMs) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(nowMs));
  const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}

export function addDays(ymd, count) {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + count));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function weekdayOf(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return addDays(value, 0) === value;
}

export function dateLabel(ymd, withWeekday = true) {
  const [y, m, d] = ymd.split("-").map(Number);
  const text = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "UTC", day: "numeric", month: "long", ...(withWeekday ? { weekday: "long" } : {})
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function shortDay(ymd) {
  const [, m, d] = ymd.split("-");
  return `${WEEKDAY_SHORT[weekdayOf(ymd)]} ${d}.${m}`;
}

export function slotsFor(branch, ymd) {
  return [...(branch.schedule[weekdayOf(ymd)] || [])];
}

// Москва — постоянно UTC+3.
export function slotStartMs(date, time) {
  return Date.parse(`${date}T${time}:00+03:00`);
}

/* ================================ ТЕКСТЫ ===================================== */

export function pluralChildren(n) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n100 >= 11 && n100 <= 14) return "детей";
  if (n10 === 1) return "ребёнок";
  if (n10 >= 2 && n10 <= 4) return "ребёнка";
  return "детей";
}

export function cleanChildName(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028-\u202E\u2060-\u206F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeChildName(name) {
  return cleanChildName(name).toLocaleLowerCase("ru").replace(/ё/g, "е");
}

export function isAcceptableChildName(name) {
  return name.length >= 2 && name.length <= 40 && !name.startsWith("/") && /\p{L}/u.test(name);
}

function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/* ================================ TELEGRAM =================================== */

export class TelegramError extends Error {
  constructor(method, { code = 0, description = "", retryAfter = 0, network = false } = {}) {
    super(`Telegram ${method}: ${network ? "network error" : code} ${description}`.trim());
    this.name = "TelegramError";
    this.method = method;
    this.code = code;
    this.description = description;
    this.retryAfter = Number(retryAfter) || 0;
    this.network = network;
  }
}

export async function tgCall(token, method, payload = {}) {
  if (!token) throw new TelegramError(method, { description: "BOT_TOKEN is not set" });

  let response;

  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    // Токен в текст ошибки не попадает: URL не логируется.
    throw new TelegramError(method, { network: true, description: String(error?.message || error) });
  }

  let data = null;

  try {
    data = await response.json();
  } catch (_) {
    data = null;
  }

  if (!data) {
    throw new TelegramError(method, {
      code: response.status, description: `HTTP ${response.status}`, network: response.status >= 500
    });
  }

  if (!data.ok) {
    throw new TelegramError(method, {
      code: data.error_code || response.status,
      description: data.description || "unknown error",
      retryAfter: data.parameters?.retry_after
    });
  }

  return data.result;
}

export const isNotModified = e => /message is not modified/i.test(String(e?.description || e?.message || ""));
export const isMessageGone = e =>
  /message to edit not found|message can't be edited|message_id_invalid|message not found|message to delete not found|message can't be deleted/i
    .test(String(e?.description || e?.message || ""));

function isPermanentTelegramError(e) {
  return e instanceof TelegramError && !e.network && [400, 401, 403, 404].includes(Number(e.code));
}

/* ============================ МИГРАЦИЯ KV: ПЛАН ============================== */

function extractRefs(value) {
  let items = [];
  if (Array.isArray(value)) items = value;
  else if (Array.isArray(value?.bookings)) items = value.bookings;
  else if (Array.isArray(value?.bookingIds)) items = value.bookingIds;
  else if (Array.isArray(value?.ids)) items = value.ids;

  return items
    .map(item => (typeof item === "string" ? item : (item?.id || item?.bookingId || item?.booking_id || "")))
    .filter(item => typeof item === "string" && item.length > 0);
}

function normalizeLegacyBooking(raw, idHint, dateHint, timeHint) {
  if (!raw || typeof raw !== "object") return null;

  const id = String(raw.id || raw.bookingId || raw.booking_id || idHint || "");
  const childName = cleanChildName(raw.childName || raw.child || raw.studentName || raw.name || "");
  const date = String(raw.date || raw.sessionDate || raw.day || dateHint || "");
  const time = String(raw.time || raw.sessionTime || timeHint || "");
  const parentId = String(
    raw.parentId ?? raw.userId ?? raw.telegramUserId ?? raw.parent_id ?? raw.user_id ?? raw.ownerId ?? raw.fromId ?? ""
  );

  if (!id || !childName || !date || !time) return null;

  return {
    id,
    date,
    time,
    childName: childName.slice(0, 80),
    parentId,
    parentName: String(raw.parentName || "").slice(0, 120),
    createdAtRaw: raw.createdAt
  };
}

/**
 * Чистая функция: превращает снимок KV в список броней для импорта.
 * Ничего не теряет: всё, что нельзя считать активной бронью, импортируется как отменённое
 * с причиной; невосстановимые записи попадают в skipped с объяснением.
 */
export function planLegacyImport(branch, snapshot, nowMs) {
  const b = branch.id;
  const plan = new Map();
  const skipped = [];
  const warnings = [];
  const fromDayObjects = new Set();

  const add = (rec, status, reason) => {
    const existing = plan.get(rec.id);
    if (existing && existing.status === "active") return;
    plan.set(rec.id, { ...rec, status, reason });
  };

  // Формат этапа 1: day:P03:<date> — единственный источник правды для своей даты.
  for (const [key, value] of Object.entries(snapshot.days || {})) {
    const date = key.slice(`day:${b}:`.length);

    if (!isValidDate(date) || !Array.isArray(value?.bookings)) {
      warnings.push(`Пропущен ключ ${key}: неизвестный формат`);
      continue;
    }

    fromDayObjects.add(date);

    for (const raw of value.bookings) {
      const rec = normalizeLegacyBooking(raw, raw?.id, date, raw?.time);
      if (!rec) skipped.push({ source: key, reason: "неполная запись в объекте дня" });
      else add(rec, "active", "stage1_day");
    }
  }

  // Формат этапа 0: session:P03:<date>:<time> → список id, booking:<id> → данные.
  for (const [key, value] of Object.entries(snapshot.sessions || {})) {
    const rest = key.slice(`session:${b}:`.length);
    const date = rest.slice(0, 10);
    const time = rest.slice(11);

    if (!isValidDate(date)) {
      warnings.push(`Пропущен ключ ${key}: неверная дата`);
      continue;
    }

    for (const ref of extractRefs(value)) {
      if (fromDayObjects.has(date)) continue;

      let raw = snapshot.bookings?.[`booking:${ref}`];

      if (!raw && Array.isArray(value)) {
        raw = value.find(item => item && typeof item === "object" && String(item.id || item.bookingId || "") === ref);
      }

      const rec = normalizeLegacyBooking(raw, ref, date, time);
      if (!rec) skipped.push({ source: key, id: ref, reason: "нет данных брони (booking:<id> отсутствует)" });
      else add(rec, "active", "session_list");
    }
  }

  // booking:<id>, на которые не ссылается ни один активный список: в старом коде они не
  // показывались в списках (отменены или «осиротели» из-за сбоя). Импортируем как отменённые.
  for (const [key, value] of Object.entries(snapshot.bookings || {})) {
    const id = key.slice("booking:".length);
    if (plan.has(id)) continue;
    if (value?.branchId && value.branchId !== b) continue;

    const rec = normalizeLegacyBooking(value, id);
    if (!rec) skipped.push({ source: key, reason: "неполная запись booking" });
    else add(rec, "cancelled", "not_in_active_list");
  }

  const bookings = [];
  const activeKeys = new Map();

  const sorted = [...plan.values()].sort((x, y) =>
    String(x.createdAtRaw || "").localeCompare(String(y.createdAtRaw || "")) || x.id.localeCompare(y.id)
  );

  for (const rec of sorted) {
    let { status, reason } = rec;
    const formatOk = isValidDate(rec.date) && /^\d{2}:\d{2}$/.test(rec.time);

    if (!formatOk) {
      skipped.push({ id: rec.id, reason: `неверная дата/время: ${rec.date} ${rec.time}` });
      continue;
    }

    if (status === "active" && !slotsFor(branch, rec.date).includes(rec.time)) {
      status = "cancelled";
      reason = "invalid_slot";
    }

    const parentId = rec.parentId || "legacy-unknown";
    if (!rec.parentId) warnings.push(`Бронь ${rec.id}: не указан родитель`);

    const normalized = normalizeChildName(rec.childName);
    const uniqueKey = `${rec.date}|${rec.time}|${parentId}|${normalized}`;

    if (status === "active") {
      if (activeKeys.has(uniqueKey)) {
        status = "cancelled";
        reason = `duplicate_of:${activeKeys.get(uniqueKey)}`;
      } else {
        activeKeys.set(uniqueKey, rec.id);
      }
    }

    const createdAt = Number.isFinite(Date.parse(rec.createdAtRaw)) ? Date.parse(rec.createdAtRaw) : nowMs;

    bookings.push({
      id: rec.id,
      date: rec.date,
      time: rec.time,
      childName: rec.childName,
      normalized,
      parentId,
      parentName: rec.parentName,
      status,
      reason,
      createdAt
    });
  }

  const boards = [];

  for (const [key, value] of Object.entries(snapshot.dayboards || {})) {
    const date = key.slice(`dayboard:${b}:`.length);
    if (!isValidDate(date)) continue;

    const messageId = typeof value === "number" || typeof value === "string"
      ? Number(value)
      : Number(value?.messageId || value?.message_id || value?.id || 0);
    const chatId = typeof value === "object" && value ? String(value.chatId ?? value.chat_id ?? "") : "";

    if (messageId > 0) boards.push({ date, messageId, chatId });
  }

  let panel = null;
  const branchValue = snapshot.branch;

  if (branchValue && typeof branchValue === "object") {
    const messageId = Number(branchValue.panelMessageId || branchValue.messageId || branchValue.panel_message_id || 0);
    if (messageId > 0 && branchValue.chatId) {
      panel = { chatId: String(branchValue.chatId), messageId, page: Number(branchValue.page) || 0 };
    }
  }

  const importedIds = new Set(bookings.map(item => item.id));
  let parentIndexEntries = 0;
  let parentIndexUnknown = 0;

  for (const value of Object.values(snapshot.parents || {})) {
    for (const ref of extractRefs(value)) {
      parentIndexEntries++;
      if (!importedIds.has(ref)) parentIndexUnknown++;
    }
  }

  return { bookings, boards, panel, skipped, warnings, parentIndexEntries, parentIndexUnknown };
}

/* ============================ DURABLE OBJECT ================================= */

class RollbackForDryRun extends Error {
  constructor(report) {
    super("dry run");
    this.report = report;
  }
}

class MigrationVerificationError extends Error {
  constructor(report) {
    super("migration verification failed");
    this.report = report;
  }
}

export class BranchBookingDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.branch = null;
    this.draining = false;
    this.drainAgain = false;
    this.enqueued = 0;

    ctx.blockConcurrencyWhile(async () => {
      this.initSchema();
    });
  }

  /* ----------------------------- инфраструктура ---------------------------- */

  now() {
    // Только для автотестов: env.TEST_NOW. В Cloudflare такой привязки нет.
    return typeof this.env?.TEST_NOW === "function" ? this.env.TEST_NOW() : Date.now();
  }

  all(query, ...params) {
    return this.sql.exec(query, ...params).toArray();
  }

  one(query, ...params) {
    return this.all(query, ...params)[0] ?? null;
  }

  run(query, ...params) {
    this.sql.exec(query, ...params);
  }

  tx(fn) {
    return this.ctx.storage.transactionSync(fn);
  }

  getMeta(key) {
    return this.one("SELECT value FROM meta WHERE key = ?", key)?.value ?? null;
  }

  setMeta(key, value) {
    this.run(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key, String(value)
    );
  }

  initSchema() {
    this.tx(() => {
      for (const statement of SCHEMA) this.sql.exec(statement);
      if (this.getMeta("schema_version") !== SCHEMA_VERSION) this.setMeta("schema_version", SCHEMA_VERSION);
    });

    const branchId = this.getMeta("branch_id");
    if (branchId && BRANCHES[branchId]) this.branch = BRANCHES[branchId];
  }

  ensureBranch(branchId) {
    const branch = BRANCHES[branchId];
    if (!branch) throw new Error(`Unknown branch ${branchId}`);

    const stored = this.getMeta("branch_id");

    if (!stored) this.setMeta("branch_id", branchId);
    else if (stored !== branchId) throw new Error(`Branch mismatch: object is ${stored}, request is ${branchId}`);

    this.branch = branch;
  }

  allowedChatId() {
    return this.branch ? parseBranchChats(this.env)[this.branch.id] || null : null;
  }

  botId() {
    return botIdFromToken(this.env?.BOT_TOKEN);
  }

  tg(method, payload) {
    return tgCall(this.env?.BOT_TOKEN, method, payload);
  }

  enqueue(eventType, payload, { dedupeKey = null, priority = PRIORITY.urgent } = {}) {
    const now = this.now();
    const inserted = this.all(
      `INSERT OR IGNORE INTO outbox
         (event_type, dedupe_key, payload, priority, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
       RETURNING id`,
      eventType, dedupeKey, JSON.stringify(payload), priority, now, now, now
    );
    this.enqueued++;
    return inserted[0]?.id ?? null;
  }

  notice(chatId, text, replyToMessageId = null) {
    this.enqueue("notice", { chat_id: String(chatId), text, reply_to: replyToMessageId });
  }

  bumpDay(date) {
    this.run(
      `INSERT INTO day_state (date, revision) VALUES (?, 1)
       ON CONFLICT (date) DO UPDATE SET revision = revision + 1`,
      date
    );
  }

  requestDaySync(date) {
    this.enqueue("board_sync", { date }, { dedupeKey: `board:${date}`, priority: PRIORITY.board });
    this.enqueue("panel_sync", {}, { dedupeKey: "panel", priority: PRIORITY.panel });
  }

  isFutureSlot(date, time) {
    return slotStartMs(date, time) > this.now();
  }

  isAllowedSlot(date, time) {
    return isValidDate(date) && slotsFor(this.branch, date).includes(time) && this.isFutureSlot(date, time);
  }

  async armAlarm(atMs) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current === undefined || current > atMs) {
      await this.ctx.storage.setAlarm(atMs);
    }
  }

  /* ------------------------------ RPC: updates ----------------------------- */

  /**
   * Обрабатывает один Telegram update атомарно:
   * проверка update_id + бизнес-изменение + задачи outbox + отметка update_id —
   * одна транзакция. Повторная доставка того же update_id ничего не меняет.
   * При ошибке SQLite транзакция откатывается целиком и исключение уходит в Worker,
   * который отвечает Telegram 500 — Telegram повторит доставку.
   */
  async handleUpdate(branchId, update, meta = {}) {
    this.ensureBranch(branchId);

    const updateId = Number(update?.update_id);
    if (!Number.isSafeInteger(updateId)) return { status: "invalid" };

    this.enqueued = 0;

    const result = this.tx(() => {
      const seen = this.one("SELECT processing_status, result FROM telegram_updates WHERE update_id = ?", updateId);
      if (seen) return { duplicate: true, code: seen.result };

      const outcome = this.processUpdate(update, meta) || { ignored: true };

      this.run(
        `INSERT INTO telegram_updates (update_id, kind, processing_status, result, processed_at)
         VALUES (?, ?, ?, ?, ?)`,
        updateId,
        outcome.kind || "other",
        outcome.ignored ? "ignored" : "done",
        outcome.code || null,
        this.now()
      );

      return outcome;
    });

    const enqueued = this.enqueued > 0;
    // Страховка: если Worker не дождётся drain(), задачи выполнит будильник.
    if (enqueued) await this.armAlarm(this.now() + SAFETY_ALARM_MS);

    return {
      duplicate: !!result.duplicate,
      code: result.code || null,
      answer: result.answer || null,
      enqueued
    };
  }

  processUpdate(update, meta) {
    if (update.callback_query) return this.onCallback(update.callback_query, meta);
    if (update.message) return this.onMessage(update.message, meta);
    return { ignored: true, kind: "other" };
  }

  /* ------------------------------ сообщения -------------------------------- */

  onMessage(msg, meta) {
    const chatId = String(msg.chat?.id ?? "");
    const text = String(msg.text || "").trim();

    if (msg.from?.is_bot) return { ignored: true, kind: "message" };

    const init = parseInitCommand(text);
    if (init) return this.onInit(msg, init, meta);

    if (chatId !== this.allowedChatId()) return { ignored: true, kind: "message", code: "foreign_chat" };

    if (msg.reply_to_message) {
      const handled = this.onReply(msg);
      if (handled) return handled;
    }

    if (/^\/help(?:@\w+)?(?:\s|$)/i.test(text)) {
      this.notice(
        chatId,
        `PRIDE ONE — запись в филиал ${this.branch.name}.\n\n` +
        "1. Нажмите кнопку с датой и временем в расписании.\n" +
        "2. Ответьте (Reply) на сообщение бота именем ребёнка.\n" +
        "3. Для отмены нажмите «Отменить эту запись» в подтверждении или «Мои записи» в расписании.\n\n" +
        `Публикация панели (администратор группы): /init ${this.branch.id}`
      );
      return { kind: "help", code: "help" };
    }

    return { ignored: true, kind: "message" };
  }

  onInit(msg, init, meta) {
    const chatId = String(msg.chat?.id ?? "");
    const chatType = msg.chat?.type;

    if (chatType !== "group" && chatType !== "supergroup") {
      this.notice(chatId, "Команда /init работает только в группе филиала.");
      return { kind: "init", code: "init_private_refused" };
    }

    if (init.branchArg !== this.branch.id) {
      if (meta.isAdmin) this.notice(chatId, `Укажите филиал: /init ${this.branch.id}`, msg.message_id);
      return { kind: "init", code: "init_wrong_branch" };
    }

    if (chatId !== this.allowedChatId()) {
      if (meta.isAdmin) {
        this.notice(
          chatId,
          `Эта группа не подключена к филиалу ${this.branch.id}. ID группы: ${chatId}. ` +
          "Его нужно указать в настройке BRANCH_CHATS.",
          msg.message_id
        );
      }
      return { kind: "init", code: "init_foreign_chat" };
    }

    if (!meta.isAdmin) {
      this.notice(chatId, "Публиковать панель расписания может только администратор группы.", msg.message_id);
      return { kind: "init", code: "init_not_admin" };
    }

    // Идемпотентно: если панель уже есть — она будет отредактирована (и вернётся на первую неделю),
    // новая публикуется, только если сохранённого сообщения нет или его удалили.
    this.run("UPDATE telegram_messages SET page = 0, rendered_hash = '' WHERE kind = 'panel' AND ref = ''");
    this.enqueue("panel_publish", { chat_id: chatId }, { dedupeKey: "panel_publish", priority: PRIORITY.urgent });
    this.enqueue("delete_message", { chat_id: chatId, message_id: msg.message_id }, { priority: PRIORITY.cleanup });
    return { kind: "init", code: "init_ok" };
  }

  findPrompt(chatId, reply) {
    let prompt = this.one(
      "SELECT * FROM pending_prompts WHERE chat_id = ? AND prompt_message_id = ?",
      chatId, reply.message_id
    );

    // Запасной путь: если ответ Telegram на sendMessage был потерян, message_id формы
    // неизвестен, но номер формы есть в тексте сообщения бота.
    if (!prompt && String(reply.from?.id ?? "") === this.botId()) {
      const match = String(reply.text || "").match(/Форма №(\d+)/);

      if (match) {
        const found = this.one("SELECT * FROM pending_prompts WHERE id = ?", Number(match[1]));
        if (found && found.chat_id === chatId) {
          prompt = found;
          if (!found.prompt_message_id) {
            this.run(
              `UPDATE pending_prompts SET prompt_message_id = ?
               WHERE id = ? AND prompt_message_id IS NULL
                 AND NOT EXISTS (SELECT 1 FROM pending_prompts p2 WHERE p2.chat_id = ? AND p2.prompt_message_id = ?)`,
              reply.message_id, found.id, chatId, reply.message_id
            );
          }
        }
      }
    }

    return prompt;
  }

  onReply(msg) {
    const chatId = String(msg.chat.id);
    const reply = msg.reply_to_message;
    const prompt = this.findPrompt(chatId, reply);
    const fromBot = String(reply.from?.id ?? "") === this.botId();

    if (!prompt) {
      if (fromBot && String(reply.text || "").includes(PROMPT_MARK)) {
        this.notice(chatId, "Эта форма записи устарела. Нажмите нужное время в расписании ещё раз.", msg.message_id);
        return { kind: "reply", code: "prompt_unknown" };
      }
      return null;
    }

    const parentId = String(msg.from?.id ?? "");
    const promptMessageId = prompt.prompt_message_id || reply.message_id;

    if (parentId !== prompt.parent_id) {
      this.notice(
        chatId,
        "Эта форма записи открыта другим родителем. Нажмите время в расписании, чтобы начать свою запись.",
        msg.message_id
      );
      return { kind: "reply", code: "prompt_not_owner" };
    }

    if (prompt.status === "used") {
      this.notice(
        chatId,
        "Эта форма уже использована. Чтобы записать ещё одного ребёнка, снова нажмите время в расписании.",
        msg.message_id
      );
      return { kind: "reply", code: "prompt_used" };
    }

    if (prompt.status !== "open") {
      this.notice(chatId, "Эта форма записи закрыта. Нажмите нужное время в расписании ещё раз.", msg.message_id);
      return { kind: "reply", code: "prompt_closed" };
    }

    if (this.now() > prompt.expires_at) {
      this.run("UPDATE pending_prompts SET status = 'expired' WHERE id = ? AND status = 'open'", prompt.id);
      this.enqueue("delete_message", { chat_id: chatId, message_id: promptMessageId }, { priority: PRIORITY.cleanup });
      this.notice(chatId, "Время ожидания истекло. Нажмите нужное время в расписании ещё раз.");
      return { kind: "reply", code: "prompt_expired" };
    }

    const childName = cleanChildName(msg.text);

    if (!isAcceptableChildName(childName)) {
      this.notice(chatId, "Укажите имя ребёнка от 2 до 40 символов — ответом (Reply) на сообщение бота.", msg.message_id);
      return { kind: "reply", code: "bad_name" };
    }

    if (!this.isAllowedSlot(prompt.date, prompt.time)) {
      this.run("UPDATE pending_prompts SET status = 'closed' WHERE id = ?", prompt.id);
      this.enqueue("delete_message", { chat_id: chatId, message_id: promptMessageId }, { priority: PRIORITY.cleanup });
      this.notice(chatId, "Это время уже прошло или недоступно для записи. Выберите другое время в расписании.");
      return { kind: "reply", code: "slot_closed" };
    }

    const normalized = normalizeChildName(childName);
    const id = crypto.randomUUID();
    const now = this.now();
    const parentName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ").slice(0, 120);

    // Уникальный индекс ux_bookings_active_child и prompt_id UNIQUE решают на уровне SQLite,
    // можно ли создать бронь. INSERT OR IGNORE + RETURNING: пустой результат = отказ.
    const inserted = this.all(
      `INSERT OR IGNORE INTO bookings
         (id, branch_id, date, time, child_name, normalized_child_name, parent_id, parent_name,
          status, source, prompt_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 'bot', ?, ?)
       RETURNING id`,
      id, this.branch.id, prompt.date, prompt.time, childName, normalized, parentId, parentName, prompt.id, now
    );

    if (!inserted.length) {
      const duplicate = this.one(
        `SELECT child_name FROM bookings
         WHERE branch_id = ? AND date = ? AND time = ? AND parent_id = ? AND normalized_child_name = ? AND status = 'active'`,
        this.branch.id, prompt.date, prompt.time, parentId, normalized
      );

      if (!duplicate) {
        // Отказ не из-за дубликата — значит, нарушено другое ограничение. Откатываем всё.
        throw new Error("Booking insert rejected by a constraint other than the duplicate rule");
      }

      this.run("UPDATE pending_prompts SET status = 'closed' WHERE id = ?", prompt.id);
      this.enqueue("delete_message", { chat_id: chatId, message_id: promptMessageId }, { priority: PRIORITY.cleanup });
      this.enqueue("delete_message", { chat_id: chatId, message_id: msg.message_id }, { priority: PRIORITY.cleanup });
      this.notice(
        chatId,
        `${duplicate.child_name} уже записан(а) на ${dateLabel(prompt.date)}, ${prompt.time}. ` +
        "Повторная запись не создана. Чтобы записать другого ребёнка, нажмите время и укажите его имя."
      );
      return { kind: "reply", code: "duplicate" };
    }

    this.run(
      "UPDATE pending_prompts SET status = 'used', booking_id = ? WHERE id = ? AND status = 'open'",
      id, prompt.id
    );
    this.run(
      "INSERT INTO booking_events (booking_id, event, actor_id, at) VALUES (?, 'created', ?, ?)",
      id, parentId, now
    );
    this.bumpDay(prompt.date);

    this.enqueue("send_confirmation", { booking_id: id }, { dedupeKey: `confirm:${id}`, priority: PRIORITY.urgent });
    this.requestDaySync(prompt.date);
    this.enqueue("delete_message", { chat_id: chatId, message_id: promptMessageId }, { priority: PRIORITY.cleanup });
    this.enqueue("delete_message", { chat_id: chatId, message_id: msg.message_id }, { priority: PRIORITY.cleanup });

    return { kind: "reply", code: "booked" };
  }

  /* ------------------------------- кнопки ---------------------------------- */

  onCallback(cb, meta) {
    const chatId = String(cb.message?.chat?.id ?? "");
    const parts = String(cb.data || "").split("|");
    const action = parts[0];

    if (!cb.message || chatId !== this.allowedChatId()) {
      return { kind: "callback", code: "foreign_chat", answer: { text: "Кнопка недоступна в этом чате.", alert: true } };
    }

    const userId = String(cb.from?.id ?? "");
    const messageId = cb.message.message_id;
    const clickedText = String(cb.message.text || "");

    switch (action) {
      case "book":
        return this.onBook(cb, parts[1], parts[2], parts[3]);

      case "mine":
        this.enqueue("my_list_send", {
          chat_id: chatId,
          parent_id: userId,
          parent_name: [cb.from.first_name, cb.from.last_name].filter(Boolean).join(" ")
        });
        return { kind: "callback", code: "mine", answer: { text: "Ваши записи — в новом сообщении" } };

      case "close":
        if (parts[2] && parts[2] !== userId) {
          return { kind: "callback", code: "close_not_owner", answer: { text: "Это список другого родителя.", alert: true } };
        }
        this.enqueue("delete_message", { chat_id: chatId, message_id: messageId }, { priority: PRIORITY.urgent });
        return { kind: "callback", code: "close", answer: {} };

      case "page":
      case "refresh": {
        if (action === "refresh" && clickedText.startsWith(MY_LIST_HEADER)) {
          // Старая кнопка «К расписанию» из списка «Мои записи».
          this.enqueue("delete_message", { chat_id: chatId, message_id: messageId }, { priority: PRIORITY.urgent });
          this.enqueue("panel_sync", {}, { dedupeKey: "panel", priority: PRIORITY.panel });
          return { kind: "callback", code: "refresh", answer: { text: "Расписание обновлено" } };
        }

        const panel = this.one("SELECT * FROM telegram_messages WHERE kind = 'panel' AND ref = ''");
        const isMain = panel && panel.chat_id === chatId && Number(panel.message_id) === Number(messageId);
        const page = parts[2] !== undefined
          ? Math.max(0, Math.min(PAGE_COUNT - 1, Math.trunc(Number(parts[2]) || 0)))
          : (isMain ? panel.page : 0);

        if (isMain) {
          this.run("UPDATE telegram_messages SET page = ?, rendered_hash = '' WHERE kind = 'panel' AND ref = ''", page);
          this.enqueue("panel_sync", {}, { dedupeKey: "panel", priority: PRIORITY.urgent });
        } else {
          this.enqueue("panel_render", { chat_id: chatId, message_id: messageId, page });
        }

        return { kind: "callback", code: action, answer: action === "refresh" ? { text: "Расписание обновлено" } : {} };
      }

      case "cancel": {
        // Форматы: cancel|<id> (основной), cancel|<date>|<id> (этап 1).
        const bookingId = parts.length >= 3 ? parts[2] : parts[1];
        return this.onCancel(cb, bookingId, clickedText);
      }

      default:
        return { kind: "callback", code: "stale_button", answer: { text: "Кнопка устарела. Обновите расписание.", alert: true } };
    }
  }

  onBook(cb, branchArg, date, time) {
    const chatId = String(cb.message.chat.id);
    const parentId = String(cb.from.id);

    if (branchArg !== this.branch.id || !this.isAllowedSlot(date, time)) {
      this.enqueue("panel_sync", {}, { dedupeKey: "panel", priority: PRIORITY.panel });
      return { kind: "callback", code: "slot_unavailable", answer: { text: "Это время уже прошло или недоступно.", alert: true } };
    }

    const now = this.now();
    const recent = this.one(
      `SELECT id FROM pending_prompts
       WHERE parent_id = ? AND chat_id = ? AND date = ? AND time = ? AND status = 'open' AND created_at > ?
       ORDER BY id DESC LIMIT 1`,
      parentId, chatId, date, time, now - PROMPT_REUSE_MS
    );

    if (recent) {
      return {
        kind: "callback",
        code: "prompt_exists",
        answer: { text: "Форма уже открыта — ответьте на сообщение бота именем ребёнка." }
      };
    }

    const parentName = [cb.from.first_name, cb.from.last_name].filter(Boolean).join(" ").slice(0, 120);
    const created = this.all(
      `INSERT INTO pending_prompts
         (branch_id, chat_id, parent_id, parent_name, date, time, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
       RETURNING id`,
      this.branch.id, chatId, parentId, parentName, date, time, now, now + PROMPT_TTL_MS
    );

    this.enqueue("send_prompt", { prompt_id: created[0].id }, { dedupeKey: `prompt:${created[0].id}` });

    return { kind: "callback", code: "prompt_created", answer: { text: "Ответьте на сообщение бота именем ребёнка." } };
  }

  onCancel(cb, bookingId, clickedText) {
    const chatId = String(cb.message.chat.id);
    const userId = String(cb.from.id);
    const booking = bookingId ? this.one("SELECT * FROM bookings WHERE id = ?", bookingId) : null;

    if (!booking || booking.branch_id !== this.branch.id) {
      return { kind: "callback", code: "cancel_not_found", answer: { text: "Запись не найдена.", alert: true } };
    }

    if (booking.parent_id !== userId) {
      return {
        kind: "callback",
        code: "cancel_not_owner",
        answer: { text: "Отменить эту запись может только родитель, который её оформил.", alert: true }
      };
    }

    const clickedIsList = clickedText.startsWith(MY_LIST_HEADER);
    const clickedIsConfirmation = clickedText.startsWith(CONFIRM_HEADER);
    const fallback = clickedIsConfirmation ? { chat_id: chatId, message_id: cb.message.message_id } : {};

    if (booking.status === "cancelled") {
      this.enqueue("confirmation_cancelled", { booking_id: booking.id, ...fallback }, { priority: PRIORITY.urgent });
      if (clickedIsList) this.enqueueMyListEdit(cb);
      return { kind: "callback", code: "cancel_already", answer: { text: "Эта запись уже отменена.", alert: true } };
    }

    if (!this.isFutureSlot(booking.date, booking.time)) {
      return {
        kind: "callback",
        code: "cancel_started",
        answer: { text: "Занятие уже началось — отмена через бота недоступна.", alert: true }
      };
    }

    const now = this.now();
    // Владелец проверяется и в самом UPDATE.
    const updated = this.all(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?
       WHERE id = ? AND status = 'active' AND parent_id = ?
       RETURNING id`,
      now, userId, booking.id, userId
    );

    if (!updated.length) throw new Error("Cancel affected no rows inside a serialized transaction");

    this.run(
      "INSERT INTO booking_events (booking_id, event, actor_id, at) VALUES (?, 'cancelled', ?, ?)",
      booking.id, userId, now
    );
    this.bumpDay(booking.date);
    this.requestDaySync(booking.date);
    this.enqueue("confirmation_cancelled", { booking_id: booking.id, ...fallback }, { priority: PRIORITY.urgent });
    if (clickedIsList) this.enqueueMyListEdit(cb);

    return { kind: "callback", code: "cancelled", answer: { text: "Запись отменена" } };
  }

  enqueueMyListEdit(cb) {
    this.enqueue("my_list_edit", {
      chat_id: String(cb.message.chat.id),
      message_id: cb.message.message_id,
      parent_id: String(cb.from.id),
      parent_name: [cb.from.first_name, cb.from.last_name].filter(Boolean).join(" ")
    });
  }

  /* ------------------------------- рендеринг ------------------------------- */

  slotCounts(date) {
    const counts = {};
    for (const row of this.all(
      "SELECT time, COUNT(*) AS c FROM bookings WHERE branch_id = ? AND date = ? AND status = 'active' GROUP BY time",
      this.branch.id, date
    )) {
      counts[row.time] = Number(row.c);
    }
    return counts;
  }

  renderPanel(page) {
    const now = this.now();
    const start = addDays(todayMoscow(now), page * 7);
    const end = addDays(start, 6);
    const rows = [];
    const lines = [];

    for (let offset = 0; offset < 7; offset++) {
      const date = addDays(start, offset);
      const slots = slotsFor(this.branch, date).filter(time => slotStartMs(date, time) > now);
      if (!slots.length) continue;

      const counts = this.slotCounts(date);
      lines.push(`${dateLabel(date)}: ` + slots.map(time => `${time} — ${counts[time] || 0}`).join(", "));
      rows.push(slots.map(time => ({
        text: `${shortDay(date)} · ${time} (${counts[time] || 0})`,
        callback_data: `book|${this.branch.id}|${date}|${time}`
      })));
    }

    const text =
      `${PANEL_HEADER}\nФилиал: ${this.branch.name}\n\n` +
      "Нажмите кнопку с датой и временем. В скобках — сколько детей уже записано.\n\n" +
      (lines.length ? lines.join("\n") : "На этой неделе занятий больше нет. Перейдите к следующей неделе.") +
      `\n\nПериод: ${shortDay(start)} — ${shortDay(end)}`;

    rows.push([
      { text: "Мои записи", callback_data: `mine|${this.branch.id}` },
      { text: "Обновить", callback_data: `refresh|${this.branch.id}|${page}` }
    ]);

    const nav = [];
    if (page > 0) nav.push({ text: "← Предыдущая", callback_data: `page|${this.branch.id}|${page - 1}` });
    if (page < PAGE_COUNT - 1) nav.push({ text: "Следующая →", callback_data: `page|${this.branch.id}|${page + 1}` });
    if (nav.length) rows.push(nav);

    return { text, reply_markup: { inline_keyboard: rows } };
  }

  renderBoard(date) {
    const bookings = this.all(
      `SELECT time, child_name FROM bookings
       WHERE branch_id = ? AND date = ? AND status = 'active'
       ORDER BY time, created_at, rowid`,
      this.branch.id, date
    );

    const lines = [BOARD_HEADER, `Филиал: ${this.branch.name}`, dateLabel(date), ""];

    for (const time of slotsFor(this.branch, date)) {
      const atTime = bookings.filter(item => item.time === time);
      lines.push(`${time} — ${atTime.length} ${pluralChildren(atTime.length)}`);
      if (atTime.length) for (const item of atTime) lines.push(`• ${item.child_name}`);
      else lines.push("Пока нет записей");
      lines.push("");
    }

    lines.push("Список обновляется автоматически после каждой записи и отмены.");

    return { text: lines.join("\n"), activeCount: bookings.length };
  }

  renderMyList(parentId, parentName) {
    const now = this.now();
    const rows = this.all(
      `SELECT id, date, time, child_name FROM bookings
       WHERE branch_id = ? AND parent_id = ? AND status = 'active' AND date >= ?
       ORDER BY date, time, created_at`,
      this.branch.id, parentId, todayMoscow(now)
    ).filter(item => slotStartMs(item.date, item.time) > now);

    const name = parentName || "Родитель";
    const close = [{ text: "Закрыть", callback_data: `close|${this.branch.id}|${parentId}` }];

    if (!rows.length) {
      return {
        text: `${MY_LIST_HEADER}\nРодитель: ${name}\n\nПредстоящих записей нет.`,
        reply_markup: { inline_keyboard: [close] }
      };
    }

    const lines = [MY_LIST_HEADER, `Родитель: ${name}`, ""];
    const buttons = [];

    for (const item of rows.slice(0, MAX_LIST_ITEMS)) {
      lines.push(`${dateLabel(item.date)}, ${item.time} — ${item.child_name}`);
      buttons.push([{
        text: `Отменить · ${item.child_name} · ${shortDay(item.date)} ${item.time}`,
        callback_data: `cancel|${item.id}`
      }]);
    }

    lines.push(
      "",
      "Нажмите кнопку нужной записи, чтобы отменить её.",
      "Отменить запись может только родитель, который её оформил.",
      "Этот список виден всем участникам группы."
    );

    buttons.push(close);

    return { text: lines.join("\n"), reply_markup: { inline_keyboard: buttons } };
  }

  confirmationView(booking) {
    return {
      text:
        `${CONFIRM_HEADER}\n\n` +
        `Ребёнок: ${booking.child_name}\n` +
        `Филиал: ${this.branch.name}\n` +
        `Дата: ${dateLabel(booking.date)}\n` +
        `Время: ${booking.time}`,
      reply_markup: { inline_keyboard: [[{ text: "Отменить эту запись", callback_data: `cancel|${booking.id}` }]] }
    };
  }

  cancelledText(booking) {
    return (
      "Запись отменена.\n\n" +
      `Ребёнок: ${booking.child_name}\n` +
      `Дата: ${dateLabel(booking.date)}\n` +
      `Время: ${booking.time}`
    );
  }

  saveMessage(kind, ref, chatId, messageId, hash, page = 0) {
    this.run(
      `INSERT INTO telegram_messages (kind, ref, chat_id, message_id, page, rendered_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, ref) DO UPDATE SET
         chat_id = excluded.chat_id, message_id = excluded.message_id,
         page = excluded.page, rendered_hash = excluded.rendered_hash, updated_at = excluded.updated_at`,
      kind, ref, String(chatId), Number(messageId), page, hash, this.now()
    );
  }

  /* ------------------------------- outbox ---------------------------------- */

  async drain(branchId) {
    if (branchId) this.ensureBranch(branchId);
    await this.drainOutbox();
    return this.outboxSummary();
  }

  async alarm() {
    try {
      if (this.branch) this.housekeepingIfDue();
    } catch (error) {
      console.error("housekeeping failed:", error?.stack || error);
    }

    await this.drainOutbox();
  }

  async tick(branchId) {
    this.ensureBranch(branchId);
    this.tx(() => this.enqueue("panel_sync", {}, { dedupeKey: "panel", priority: PRIORITY.panel }));
    await this.armAlarm(this.now());
    return { ok: true };
  }

  housekeepingIfDue() {
    const now = this.now();
    if (Number(this.getMeta("next_housekeeping_at") || 0) > now) return;

    this.tx(() => {
      const expired = this.all(
        `UPDATE pending_prompts SET status = 'expired'
         WHERE status = 'open' AND expires_at < ?
         RETURNING chat_id, prompt_message_id`,
        now
      );

      for (const row of expired) {
        if (row.prompt_message_id) {
          this.enqueue("delete_message", { chat_id: row.chat_id, message_id: row.prompt_message_id }, { priority: PRIORITY.cleanup });
        }
      }

      this.run("DELETE FROM telegram_updates WHERE processed_at < ?", now - KEEP_UPDATES_MS);
      this.run("DELETE FROM outbox WHERE status = 'done' AND updated_at < ?", now - KEEP_OUTBOX_DONE_MS);
      this.run(
        "DELETE FROM pending_prompts WHERE status <> 'open' AND created_at < ?",
        now - KEEP_UPDATES_MS
      );

      // Раз в час перерисовываем панель: прошедшие занятия исчезают из расписания.
      this.enqueue("panel_sync", {}, { dedupeKey: "panel", priority: PRIORITY.panel });
      this.setMeta("next_housekeeping_at", now + HOUSEKEEPING_MS);
    });
  }

  claimNext() {
    const now = this.now();
    if (Number(this.getMeta("tg_pause_until") || 0) > now) return null;

    return this.tx(() => {
      // Задачи, «зависшие» в sending (например, объект перезапустился во время отправки).
      // Если для того же ключа уже есть новая задача — старая не нужна (новая отрисует свежие данные).
      this.run(
        `UPDATE outbox SET status = 'done', last_error = 'superseded after lease expiry', updated_at = ?
         WHERE status = 'sending' AND lease_until < ? AND dedupe_key IS NOT NULL
           AND EXISTS (SELECT 1 FROM outbox o2 WHERE o2.dedupe_key = outbox.dedupe_key AND o2.status = 'pending')`,
        now, now
      );
      this.run(
        "UPDATE outbox SET status = 'pending', updated_at = ? WHERE status = 'sending' AND lease_until < ?",
        now, now
      );

      const row = this.one(
        `SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY priority, id LIMIT 1`,
        now
      );
      if (!row) return null;

      return this.one(
        `UPDATE outbox SET status = 'sending', attempts = attempts + 1, lease_until = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'
         RETURNING *`,
        now + OUTBOX_LEASE_MS, now, row.id
      );
    });
  }

  completeRow(row, note = null) {
    this.run(
      "UPDATE outbox SET status = 'done', lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ?",
      note, this.now(), row.id
    );
  }

  failRow(row, error) {
    const now = this.now();
    const message = String(error?.message || error).slice(0, 500);
    let attempts = Number(row.attempts);
    let nextAt;
    let permanent = false;

    if (error instanceof TelegramError && Number(error.code) === 429) {
      const wait = Math.max(1, error.retryAfter || 5) * 1000;
      nextAt = now + wait;
      attempts = Math.max(0, attempts - 1); // ожидание лимита Telegram не считается неудачной попыткой
      this.setMeta("tg_pause_until", now + wait);
    } else if (isPermanentTelegramError(error)) {
      permanent = true;
    } else {
      nextAt = now + Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
    }

    if (permanent || attempts >= OUTBOX_MAX_ATTEMPTS) {
      this.run(
        "UPDATE outbox SET status = 'failed', lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ?",
        message, now, row.id
      );
      console.error(`outbox #${row.id} ${row.event_type} failed permanently: ${message}`);
      return;
    }

    this.tx(() => {
      const sibling = row.dedupe_key
        ? this.one("SELECT id FROM outbox WHERE dedupe_key = ? AND status = 'pending' AND id <> ?", row.dedupe_key, row.id)
        : null;

      if (sibling) {
        // Есть более новая задача того же типа — она отрисует актуальные данные.
        this.completeRow(row, `superseded after error: ${message}`);
        return;
      }

      this.run(
        `UPDATE outbox SET status = 'pending', attempts = ?, next_attempt_at = ?, lease_until = NULL,
           last_error = ?, updated_at = ?
         WHERE id = ?`,
        attempts, nextAt, message, now, row.id
      );
    });
  }

  async drainOutbox() {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }

    this.draining = true;

    try {
      if (!this.branch) return;

      for (let processed = 0; processed < OUTBOX_BATCH; processed++) {
        const row = this.claimNext();

        if (!row) {
          if (this.drainAgain) {
            this.drainAgain = false;
            processed--;
            continue;
          }
          break;
        }

        try {
          const note = await this.executeRow(row);
          this.completeRow(row, note || null);
        } catch (error) {
          console.warn(`outbox #${row.id} ${row.event_type}: ${error?.message || error}`);
          this.failRow(row, error);
        }
      }
    } finally {
      this.draining = false;

      try {
        await this.scheduleNextAlarm();
      } catch (error) {
        console.error("scheduleNextAlarm failed:", error?.stack || error);
      }
    }
  }

  async scheduleNextAlarm() {
    const now = this.now();
    const pause = Number(this.getMeta("tg_pause_until") || 0);
    const pending = this.one("SELECT MIN(next_attempt_at) AS t FROM outbox WHERE status = 'pending'")?.t;
    const leased = this.one("SELECT MIN(lease_until) AS t FROM outbox WHERE status = 'sending'")?.t;
    const housekeeping = Number(this.getMeta("next_housekeeping_at") || 0) || now + HOUSEKEEPING_MS;

    const candidates = [housekeeping];
    if (pending !== null && pending !== undefined) candidates.push(Math.max(Number(pending), pause, now));
    if (leased !== null && leased !== undefined) candidates.push(Number(leased) + 1);

    const target = Math.max(now, Math.min(...candidates));
    const current = await this.ctx.storage.getAlarm();
    if (current !== target) await this.ctx.storage.setAlarm(target);
  }

  async executeRow(row) {
    const payload = JSON.parse(row.payload);

    switch (row.event_type) {
      case "send_prompt": return this.exSendPrompt(payload);
      case "send_confirmation": return this.exSendConfirmation(payload);
      case "confirmation_cancelled": return this.exConfirmationCancelled(payload);
      case "board_sync": return this.exBoardSync(payload);
      case "panel_sync": return this.exPanelSync();
      case "panel_publish": return this.exPanelPublish(payload);
      case "panel_render": return this.exPanelRender(payload);
      case "my_list_send": return this.exMyListSend(payload);
      case "my_list_edit": return this.exMyListEdit(payload);
      case "delete_message": return this.exDelete(payload);
      case "notice": return this.exNotice(payload);
      default: return `unknown event ${row.event_type}`;
    }
  }

  async exSendPrompt({ prompt_id }) {
    const prompt = this.one("SELECT * FROM pending_prompts WHERE id = ?", prompt_id);
    if (!prompt || prompt.status !== "open") return "skipped: prompt not open";
    if (prompt.prompt_message_id) return "skipped: already sent";

    const name = (prompt.parent_name.split(" ")[0] || "Родитель").slice(0, 64);
    const text =
      `${name}, запись на ${dateLabel(prompt.date)}, ${prompt.time}.\n` +
      `${PROMPT_MARK} (нажмите «Ответить»).\n` +
      `Форма №${prompt.id}`;
    const replyMarkup = { force_reply: true, selective: true, input_field_placeholder: "Имя ребёнка" };

    let sent;

    try {
      sent = await this.tg("sendMessage", {
        chat_id: prompt.chat_id,
        text,
        reply_markup: replyMarkup,
        entities: [{
          type: "text_mention",
          offset: 0,
          length: name.length,
          user: { id: Number(prompt.parent_id), is_bot: false, first_name: name }
        }]
      });
    } catch (error) {
      if (!(error instanceof TelegramError) || Number(error.code) !== 400) throw error;
      // Упоминание отклонено — отправляем без него (поле ответа откроется не автоматически).
      sent = await this.tg("sendMessage", {
        chat_id: prompt.chat_id,
        text,
        reply_markup: { ...replyMarkup, selective: false }
      });
    }

    this.run(
      `UPDATE pending_prompts SET prompt_message_id = ?
       WHERE id = ? AND prompt_message_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM pending_prompts p2 WHERE p2.chat_id = ? AND p2.prompt_message_id = ?)`,
      sent.message_id, prompt.id, prompt.chat_id, sent.message_id
    );

    // Если форму успели закрыть, пока шла отправка, — убираем сообщение.
    const after = this.one("SELECT status FROM pending_prompts WHERE id = ?", prompt.id);
    if (after?.status !== "open") {
      this.tx(() => this.enqueue("delete_message", { chat_id: prompt.chat_id, message_id: sent.message_id }, { priority: PRIORITY.cleanup }));
    }

    return null;
  }

  async exSendConfirmation({ booking_id }) {
    const booking = this.one("SELECT * FROM bookings WHERE id = ?", booking_id);
    if (!booking) return "skipped: booking missing";
    if (booking.status !== "active") return "skipped: booking cancelled before confirmation";
    if (this.one("SELECT 1 AS x FROM telegram_messages WHERE kind = 'confirmation' AND ref = ?", booking_id)) {
      return "skipped: already sent";
    }

    const chatId = this.allowedChatId();
    if (!chatId) throw new Error("BRANCH_CHATS is not configured");

    const view = this.confirmationView(booking);
    const sent = await this.tg("sendMessage", { chat_id: chatId, text: view.text, reply_markup: view.reply_markup });
    this.saveMessage("confirmation", booking_id, chatId, sent.message_id, hashText(view.text));
    return null;
  }

  async exConfirmationCancelled({ booking_id, chat_id, message_id }) {
    const booking = this.one("SELECT * FROM bookings WHERE id = ?", booking_id);
    if (!booking || booking.status !== "cancelled") return "skipped: not cancelled";

    const stored = this.one("SELECT * FROM telegram_messages WHERE kind = 'confirmation' AND ref = ?", booking_id);
    const target = stored ? { chat_id: stored.chat_id, message_id: stored.message_id } : (message_id ? { chat_id, message_id } : null);
    if (!target) return "skipped: confirmation message unknown";

    const text = this.cancelledText(booking);
    if (stored && stored.rendered_hash === hashText(text)) return "skipped: already marked";

    try {
      await this.tg("editMessageText", {
        chat_id: target.chat_id, message_id: Number(target.message_id), text, reply_markup: { inline_keyboard: [] }
      });
    } catch (error) {
      if (!isNotModified(error) && !isMessageGone(error)) throw error;
    }

    if (stored) {
      this.run(
        "UPDATE telegram_messages SET rendered_hash = ?, updated_at = ? WHERE kind = 'confirmation' AND ref = ?",
        hashText(text), this.now(), booking_id
      );
    }
    return null;
  }

  async exBoardSync({ date }) {
    const chatId = this.allowedChatId();
    if (!chatId) throw new Error("BRANCH_CHATS is not configured");

    const view = this.renderBoard(date);
    const hash = hashText(view.text);
    const stored = this.one("SELECT * FROM telegram_messages WHERE kind = 'day_board' AND ref = ?", date);

    if (stored && stored.chat_id === chatId) {
      if (stored.rendered_hash === hash) return "unchanged";

      try {
        await this.tg("editMessageText", { chat_id: stored.chat_id, message_id: Number(stored.message_id), text: view.text });
        this.saveMessage("day_board", date, stored.chat_id, stored.message_id, hash);
        return null;
      } catch (error) {
        if (isNotModified(error)) {
          this.saveMessage("day_board", date, stored.chat_id, stored.message_id, hash);
          return "not modified";
        }
        if (!isMessageGone(error)) throw error;
        // Сообщение удалили вручную — ниже публикуем новое.
      }
    } else if (view.activeCount === 0) {
      return "skipped: no bookings and no board yet";
    }

    const sent = await this.tg("sendMessage", { chat_id: chatId, text: view.text });
    this.saveMessage("day_board", date, chatId, sent.message_id, hash);
    return stored ? "board recreated" : "board created";
  }

  async exPanelSync() {
    const stored = this.one("SELECT * FROM telegram_messages WHERE kind = 'panel' AND ref = ''");
    if (!stored) return "skipped: no panel";

    const chatId = this.allowedChatId();
    if (!chatId) throw new Error("BRANCH_CHATS is not configured");

    const view = this.renderPanel(stored.page);
    const hash = hashText(view.text + JSON.stringify(view.reply_markup));
    if (stored.rendered_hash === hash && stored.chat_id === chatId) return "unchanged";

    if (stored.chat_id === chatId) {
      try {
        await this.tg("editMessageText", {
          chat_id: stored.chat_id, message_id: Number(stored.message_id), text: view.text, reply_markup: view.reply_markup
        });
        this.saveMessage("panel", "", stored.chat_id, stored.message_id, hash, stored.page);
        return null;
      } catch (error) {
        if (isNotModified(error)) {
          this.saveMessage("panel", "", stored.chat_id, stored.message_id, hash, stored.page);
          return "not modified";
        }
        if (!isMessageGone(error)) throw error;
      }
    }

    const sent = await this.tg("sendMessage", { chat_id: chatId, text: view.text, reply_markup: view.reply_markup });
    this.saveMessage("panel", "", chatId, sent.message_id, hash, stored.page);
    return "panel recreated";
  }

  async exPanelPublish({ chat_id }) {
    const chatId = this.allowedChatId();
    // Панель публикуется только в разрешённую группу филиала.
    if (!chatId || String(chat_id) !== chatId) return "skipped: chat not allowed";

    const view = this.renderPanel(0);
    const hash = hashText(view.text + JSON.stringify(view.reply_markup));
    const stored = this.one("SELECT * FROM telegram_messages WHERE kind = 'panel' AND ref = ''");

    if (stored && stored.chat_id === chatId) {
      // Панель уже есть — редактируем её, а не публикуем вторую.
      try {
        await this.tg("editMessageText", {
          chat_id: stored.chat_id, message_id: Number(stored.message_id), text: view.text, reply_markup: view.reply_markup
        });
        this.saveMessage("panel", "", stored.chat_id, stored.message_id, hash, 0);
        return "panel updated";
      } catch (error) {
        if (isNotModified(error)) {
          this.saveMessage("panel", "", stored.chat_id, stored.message_id, hash, 0);
          return "panel unchanged";
        }
        // Сетевая ошибка или 5xx: неизвестно, применилась ли правка, но повтор правки безопасен —
        // поэтому повторяем именно правку, а не публикуем новое сообщение.
        if (!isMessageGone(error)) throw error;
      }
    }

    const sent = await this.tg("sendMessage", { chat_id: chatId, text: view.text, reply_markup: view.reply_markup });
    this.saveMessage("panel", "", chatId, sent.message_id, hash, 0);
    return stored ? "panel recreated" : "panel created";
  }

  async exPanelRender({ chat_id, message_id, page }) {
    if (String(chat_id) !== this.allowedChatId()) return "skipped: chat not allowed";
    const view = this.renderPanel(page);

    try {
      await this.tg("editMessageText", {
        chat_id, message_id: Number(message_id), text: view.text, reply_markup: view.reply_markup
      });
    } catch (error) {
      if (!isNotModified(error) && !isMessageGone(error)) throw error;
    }
    return null;
  }

  async exMyListSend({ chat_id, parent_id, parent_name }) {
    if (String(chat_id) !== this.allowedChatId()) return "skipped: chat not allowed";
    const view = this.renderMyList(parent_id, parent_name);
    await this.tg("sendMessage", { chat_id, text: view.text, reply_markup: view.reply_markup });
    return null;
  }

  async exMyListEdit({ chat_id, message_id, parent_id, parent_name }) {
    if (String(chat_id) !== this.allowedChatId()) return "skipped: chat not allowed";
    const view = this.renderMyList(parent_id, parent_name);

    try {
      await this.tg("editMessageText", {
        chat_id, message_id: Number(message_id), text: view.text, reply_markup: view.reply_markup
      });
    } catch (error) {
      if (!isNotModified(error) && !isMessageGone(error)) throw error;
    }
    return null;
  }

  async exDelete({ chat_id, message_id }) {
    try {
      await this.tg("deleteMessage", { chat_id, message_id: Number(message_id) });
    } catch (error) {
      // Нет прав или сообщение уже удалено — это не ошибка данных.
      if (isPermanentTelegramError(error)) return `not deleted: ${error.description}`;
      throw error;
    }
    return null;
  }

  async exNotice({ chat_id, text, reply_to }) {
    const payload = { chat_id, text };
    if (reply_to) payload.reply_parameters = { message_id: Number(reply_to), allow_sending_without_reply: true };
    await this.tg("sendMessage", payload);
    return null;
  }

  outboxSummary() {
    const summary = { pending: 0, sending: 0, done: 0, failed: 0 };
    for (const row of this.all("SELECT status, COUNT(*) AS c FROM outbox GROUP BY status")) summary[row.status] = Number(row.c);
    return summary;
  }

  /* ------------------------------- статус ---------------------------------- */

  async status(branchId) {
    this.ensureBranch(branchId);

    const bookings = {};
    for (const row of this.all("SELECT status, source, COUNT(*) AS c FROM bookings GROUP BY status, source")) {
      bookings[`${row.source}:${row.status}`] = Number(row.c);
    }

    return {
      version: VERSION,
      branch: this.branch.id,
      schema_version: this.getMeta("schema_version"),
      allowed_chat: this.allowedChatId(),
      bookings,
      open_prompts: Number(this.one("SELECT COUNT(*) AS c FROM pending_prompts WHERE status = 'open'").c),
      processed_updates: Number(this.one("SELECT COUNT(*) AS c FROM telegram_updates").c),
      outbox: this.outboxSummary(),
      failed_outbox: this.all(
        "SELECT id, event_type, attempts, last_error, updated_at FROM outbox WHERE status = 'failed' ORDER BY id DESC LIMIT 10"
      ),
      messages: this.all("SELECT kind, ref, chat_id, message_id, page FROM telegram_messages ORDER BY kind, ref"),
      migration: this.getMeta(MIGRATION_META_KEY) ? JSON.parse(this.getMeta(MIGRATION_META_KEY)) : null,
      telegram_pause_until: Number(this.getMeta("tg_pause_until") || 0) || null,
      alarm: await this.ctx.storage.getAlarm()
    };
  }

  /* ------------------------------ миграция KV ------------------------------ */

  /**
   * Однократный импорт старых данных KV. Всё выполняется в одной транзакции:
   * вставка → проверка каждой перенесённой брони → отметка о миграции.
   * Любое расхождение откатывает импорт целиком. dryRun всегда откатывается
   * и только возвращает отчёт.
   */
  async importLegacy(branchId, snapshot, options = {}) {
    this.ensureBranch(branchId);

    const already = this.getMeta(MIGRATION_META_KEY);
    if (already && !options.force) {
      return { ok: true, alreadyDone: true, report: JSON.parse(already) };
    }

    const now = this.now();
    const plan = planLegacyImport(this.branch, snapshot, now);
    const allowedChat = this.allowedChatId();

    try {
      const report = this.tx(() => {
        let inserted = 0;
        let alreadyPresent = 0;
        const expected = [];

        for (const rec of plan.bookings) {
          if (this.one("SELECT id FROM bookings WHERE id = ?", rec.id)) {
            alreadyPresent++;
            expected.push({ ...rec, preexisting: true });
            continue;
          }

          let { status, reason } = rec;

          if (status === "active" && this.one(
            `SELECT id FROM bookings WHERE branch_id = ? AND date = ? AND time = ? AND parent_id = ?
               AND normalized_child_name = ? AND status = 'active'`,
            this.branch.id, rec.date, rec.time, rec.parentId, rec.normalized
          )) {
            status = "cancelled";
            reason = "duplicate_of_existing";
          }

          this.run(
            `INSERT INTO bookings
               (id, branch_id, date, time, child_name, normalized_child_name, parent_id, parent_name,
                status, source, prompt_id, created_at, cancelled_at, cancelled_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy_kv', NULL, ?, ?, ?)`,
            rec.id, this.branch.id, rec.date, rec.time, rec.childName, rec.normalized, rec.parentId, rec.parentName,
            status, rec.createdAt,
            status === "cancelled" ? now : null,
            status === "cancelled" ? `migration:${reason}` : null
          );
          this.run(
            "INSERT INTO booking_events (booking_id, event, actor_id, at) VALUES (?, 'imported', 'migration', ?)",
            rec.id, now
          );
          inserted++;
          expected.push({ ...rec, status, reason });
        }

        // Проверка: каждая запись плана должна лежать в SQLite ровно с ожидаемыми данными.
        const mismatches = [];

        for (const rec of expected) {
          const row = this.one("SELECT * FROM bookings WHERE id = ?", rec.id);
          if (!row) {
            mismatches.push({ id: rec.id, problem: "missing" });
            continue;
          }
          const same =
            row.date === rec.date && row.time === rec.time && row.parent_id === rec.parentId &&
            row.child_name === rec.childName && (rec.preexisting || row.status === rec.status);
          if (!same) mismatches.push({ id: rec.id, problem: "fields differ" });
        }

        const expectedActive = {};
        for (const rec of expected) {
          if (!rec.preexisting && rec.status === "active") {
            const key = `${rec.date} ${rec.time}`;
            expectedActive[key] = (expectedActive[key] || 0) + 1;
          }
        }

        for (const [key, count] of Object.entries(expectedActive)) {
          const [date, time] = key.split(" ");
          const actual = Number(this.one(
            `SELECT COUNT(*) AS c FROM bookings b
             WHERE b.branch_id = ? AND b.date = ? AND b.time = ? AND b.status = 'active' AND b.source = 'legacy_kv'
               AND EXISTS (SELECT 1 FROM booking_events e WHERE e.booking_id = b.id AND e.event = 'imported' AND e.at = ?)`,
            this.branch.id, date, time, now
          ).c);
          if (actual !== count) mismatches.push({ slot: key, problem: `active count ${actual} ≠ ${count}` });
        }

        let boardsMapped = 0;
        const boardsSkipped = [];

        for (const board of plan.boards) {
          const chat = board.chatId || allowedChat;
          if (!allowedChat || chat !== allowedChat) {
            boardsSkipped.push({ date: board.date, reason: "чат не совпадает с BRANCH_CHATS" });
            continue;
          }
          const res = this.all(
            `INSERT OR IGNORE INTO telegram_messages (kind, ref, chat_id, message_id, page, rendered_hash, updated_at)
             VALUES ('day_board', ?, ?, ?, 0, '', ?) RETURNING ref`,
            board.date, chat, board.messageId, now
          );
          if (res.length) boardsMapped++;
        }

        let panelMapped = false;
        if (plan.panel && allowedChat && plan.panel.chatId === allowedChat) {
          panelMapped = this.all(
            `INSERT OR IGNORE INTO telegram_messages (kind, ref, chat_id, message_id, page, rendered_hash, updated_at)
             VALUES ('panel', '', ?, ?, ?, '', ?) RETURNING ref`,
            allowedChat, plan.panel.messageId, Math.max(0, Math.min(PAGE_COUNT - 1, plan.panel.page)), now
          ).length > 0;
        }

        const byReason = {};
        for (const rec of expected) {
          if (rec.status === "cancelled") byReason[rec.reason] = (byReason[rec.reason] || 0) + 1;
        }

        const result = {
          verified: mismatches.length === 0,
          migrated_at: new Date(now).toISOString(),
          kv_keys_read: snapshot.keyCounts || null,
          legacy_bookings_found: plan.bookings.length,
          inserted,
          already_present: alreadyPresent,
          imported_active: expected.filter(rec => !rec.preexisting && rec.status === "active").length,
          imported_cancelled: expected.filter(rec => !rec.preexisting && rec.status === "cancelled").length,
          cancelled_reasons: byReason,
          active_by_slot: expectedActive,
          skipped: plan.skipped,
          warnings: plan.warnings,
          parent_index_entries: plan.parentIndexEntries,
          parent_index_unknown_ids: plan.parentIndexUnknown,
          day_boards_mapped: boardsMapped,
          day_boards_skipped: boardsSkipped,
          panel_mapped: panelMapped,
          mismatches
        };

        if (mismatches.length) throw new MigrationVerificationError(result);
        if (options.dryRun) throw new RollbackForDryRun(result);

        this.setMeta(MIGRATION_META_KEY, JSON.stringify(result));

        const today = todayMoscow(now);
        const dates = new Set([...expected.map(rec => rec.date), ...plan.boards.map(item => item.date)]);
        for (const date of dates) {
          this.bumpDay(date);
          if (date >= today) {
            this.enqueue("board_sync", { date }, { dedupeKey: `board:${date}`, priority: PRIORITY.board });
          }
        }
        this.enqueue("panel_sync", {}, { dedupeKey: "panel", priority: PRIORITY.panel });

        return result;
      });

      await this.armAlarm(this.now() + SAFETY_ALARM_MS);
      return { ok: true, applied: true, report };
    } catch (error) {
      if (error instanceof RollbackForDryRun) return { ok: true, dryRun: true, report: error.report };
      if (error instanceof MigrationVerificationError) return { ok: false, error: "verification_failed", report: error.report };
      throw error;
    }
  }
}
