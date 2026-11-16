/**
 * Обновление 2.0.1 → 2.0.2 и откат 2.0.2 → 2.0.1 над одними и теми же данными SQLite.
 *
 * Код 2.0.1 — замороженная копия в test/fixtures/. «Развёртывание» новой версии эмулируется так же,
 * как в Cloudflare: файл базы и будильник сохраняются, память экземпляра теряется.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Bot, U, CHAT_ID, TUE, THU, BOARD_HEADER, PANEL_HEADER } from "./harness.mjs";
import { BranchBookingDO as DO_V201 } from "./fixtures/branch-do-2.0.1.js";
import { BranchBookingDO as DO_V202 } from "../src/branch-do.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const withBot = (opts, fn) => async () => {
  const bot = new Bot(opts);
  try { await fn(bot); } finally { await sleep(60); bot.close(); }
};

const NOTICE_RE = /^Запись отменена\nРебёнок: (.+)\nДата: (.+)\nВремя: (.+)(?:\n\n[\s\S]*)?$/;
const notices = bot => bot.tg.chatMessages(CHAT_ID).filter(m => NOTICE_RE.test(m.text || ""));
/** Список дня, который публикует код 2.0.1 (в 2.0.2 такие сообщения не публикуются). */
const v201Board = bot => bot.tg.chatMessages(CHAT_ID).filter(m => String(m.text).startsWith(BOARD_HEADER)).at(-1)?.text || "";
const cancelData = c => c.reply_markup.inline_keyboard[0][0].callback_data;
const TABLES = ["meta", "bookings", "booking_events", "pending_prompts", "telegram_updates", "telegram_messages", "day_state"];

async function waitFor(cond, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (cond()) return; await sleep(10); }
  throw new Error("условие не выполнилось");
}

/** Полный снимок таблиц данных (без служебной очереди outbox). */
function snapshot(bot) {
  const out = {};
  for (const t of TABLES) out[t] = bot.sql(`SELECT * FROM ${t} ORDER BY 1, 2`);
  out.schema = bot.sql("SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY name");
  return out;
}

test("V1. Обновление 2.0.1 → 2.0.2: все данные на месте, схема не меняется, новое поведение работает", withBot({ DOClass: DO_V201 }, async bot => {
  await bot.init();
  const artem = await bot.book(U.A, TUE, "18:00", "Артём");
  const maxim = await bot.book(U.B, TUE, "18:00", "Максим");
  await bot.press(U.B, cancelData(structuredClone(maxim.confirmation)), structuredClone(maxim.confirmation));  // отмена в 2.0.1: уведомления нет
  assert.equal(bot.tg.chatMessages(CHAT_ID).filter(m => NOTICE_RE.test(m.text || "")).length, 0);
  await bot.settle();
  assert.equal(bot.sql("SELECT value FROM meta WHERE key = 'schema_version'")[0].value, "1");

  const before = snapshot(bot);
  const messagesBefore = bot.tg.chatMessages(CHAT_ID).length;

  bot.deployDO(DO_V202);                       // ← обновление кода: память потеряна, база осталась
  await bot.admin("GET", "/admin/status?branch=P03");   // первое обращение к объекту новой версии
  const after = snapshot(bot);

  assert.deepEqual(after, before, "ни одна строка данных и ни одна таблица/индекс не изменились");
  assert.equal((await bot.admin("GET", "/admin/status?branch=P03")).body.status.version, "2.0.2");
  assert.equal(bot.tg.chatMessages(CHAT_ID).length, messagesBefore, "обновление само ничего не публикует в группе");

  // Новое поведение поверх старых данных.
  await bot.press(U.A, cancelData(structuredClone(artem.confirmation)), structuredClone(artem.confirmation));
  assert.equal(notices(bot).length, 0, "отдельных уведомлений об отмене в группе нет");
  assert.doesNotMatch(bot.board(TUE), /18:00\n/, "пустое занятие не показывается");

  const again = await bot.book(U.B, TUE, "18:00", "Максим");      // повторная запись ранее отменённого — работает
  assert.ok(again.confirmation);
  assert.match(bot.board(TUE), /18:00\n• Максим\n/);
}));

test("V2. Обновление после миграции KV: миграция не повторяется, брони из KV отменяются с уведомлением", withBot({ DOClass: DO_V201 }, async bot => {
  const put = (k, v) => bot.kv.store.set(k, JSON.stringify(v));
  put(`session:P03:${TUE}:18:00`, ["b1"]);
  put("booking:b1", { id: "b1", branchId: "P03", date: TUE, time: "18:00", childName: "Тимур", parentId: "101", createdAt: "2026-11-01T10:00:00Z" });
  await bot.init();
  const mig = await bot.admin("POST", "/admin/migrate?branch=P03&dry_run=0");
  assert.equal(mig.body.report.verified, true);
  await bot.settle();
  const before = snapshot(bot);
  const kvBefore = JSON.stringify([...bot.kv.store]);

  bot.deployDO(DO_V202);
  const again = await bot.admin("POST", "/admin/migrate?branch=P03&dry_run=0");
  assert.equal(again.body.alreadyDone, true, "повторная миграция не выполняется");
  assert.deepEqual(snapshot(bot), before);
  assert.equal(JSON.stringify([...bot.kv.store]), kvBefore, "KV не изменён");

  const stale = { message_id: 1, chat: { id: CHAT_ID, type: "supergroup" }, text: "Запись подтверждена.\n\nстарое" };
  await bot.press(U.A, "cancel|b1", stale);        // кнопка старого формата, брони из KV
  assert.equal(bot.lastAnswer(), "Запись отменена");
  assert.equal(notices(bot).length, 0, "отдельных уведомлений об отмене в группе нет");
  assert.doesNotMatch(bot.board(TUE), /18:00\n/, "пустое занятие не показывается");
}));

test("V3. Задачи outbox, не завершённые до обновления, выполняются новой версией", withBot({ DOClass: DO_V201 }, async bot => {
  await bot.init();
  await bot.book(U.A, TUE, "18:00", "Артём");
  bot.tg.failNext("editMessageText", { code: 502, description: "Bad Gateway" }, { when: p => String(p.text).startsWith(BOARD_HEADER), times: 5 });
  await bot.book(U.B, TUE, "18:00", "Максим");
  assert.doesNotMatch(v201Board(bot), /Максим/);
  assert.ok(bot.sql("SELECT COUNT(*) AS c FROM outbox WHERE status = 'pending'")[0].c >= 1);

  bot.deployDO(DO_V202);
  bot.tg.rules.length = 0;
  await bot.advanceAndSettle(10_000);
  await waitFor(() => bot.sql("SELECT COUNT(*) AS c FROM outbox WHERE status IN ('pending', 'sending')")[0].c === 0);
  assert.match(bot.board(TUE), /18:00\n• Артём\n• Максим\n/, "после обновления данные — в панели, прежний список дня снят");
  assert.equal(bot.tg.chatMessages(CHAT_ID).filter(m => String(m.text).startsWith(BOARD_HEADER)).length, 0, "верхнего сообщения больше нет");
}));

test("V4. Откат 2.0.2 → 2.0.1: данные целы, зависшая правка панели безвредна, работа продолжается", withBot({ DOClass: DO_V202 }, async bot => {
  await bot.init();
  const artem = await bot.book(U.A, TUE, "18:00", "Артём");
  bot.tg.failNext("sendMessage", "hang", { when: p => String(p.text).startsWith(PANEL_HEADER) });
  await bot.press(U.A, cancelData(structuredClone(artem.confirmation)), structuredClone(artem.confirmation), { background: "drop" });
  await waitFor(() => bot.sql("SELECT status FROM outbox WHERE event_type = 'panel_sync' ORDER BY id DESC")[0]?.status === "sending");
  const bookingsBefore = bot.sql("SELECT * FROM bookings ORDER BY id");

  bot.deployDO(DO_V201);                         // ← откат на 2.0.1
  await bot.advanceAndSettle(61_000);
  await waitFor(() => bot.sql("SELECT COUNT(*) AS c FROM outbox WHERE status IN ('pending', 'sending')")[0].c === 0);

  assert.deepEqual(bot.sql("SELECT * FROM bookings ORDER BY id"), bookingsBefore, "брони не изменились");
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM outbox WHERE status = 'failed'")[0].c, 0, "очередь не сломана");
  assert.equal(notices(bot).length, 0, "уведомлений об отмене нет");
  assert.equal(bot.sql("SELECT status FROM bookings")[0].status, "cancelled");

  const next = await bot.book(U.C, TUE, "19:00", "София");     // обычная работа на 2.0.1 продолжается
  assert.ok(next.confirmation);
  assert.match(v201Board(bot), /19:00 — 1 ребёнок\n• София\n/, "2.0.1 по-прежнему публикует список дня — это её поведение");
}));
