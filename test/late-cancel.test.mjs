/**
 * Поздняя отмена (правило 3 часов): обычная — осталось 3 часа и больше (включая ровно 3 часа), поздняя — строго меньше.
 * Поздняя отмена требует подтверждения, исключается из активных записей и показывается в панели до начала занятия.
 * Признак вычисляется по сохранённым bookings.cancelled_at и booking_events('cancelled') — схема не менялась.
 */
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { Bot, U, TUE, GROUP } from "./harness.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = new TextEncoder();
const HOUR = 3600 * 1000;
const START_18 = Date.parse(`${TUE}T18:00:00+03:00`);
const WARNING = "До начала занятия менее 3 часов. При отмене занятие будет считаться использованным. Отменить запись?";

async function hmacRaw(keyBytes, data) {
  const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

async function initDataFor(bot, user) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(bot.clock.now / 1000)), query_id: "AAH", user: JSON.stringify({ id: user.id, first_name: user.first_name })
  });
  const check = [...params].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = await hmacRaw(enc.encode("WebAppData"), bot.env.BOT_TOKEN);
  params.set("hash", [...(await hmacRaw(secret, check))].map(b => b.toString(16).padStart(2, "0")).join(""));
  return params.toString();
}

async function api(bot, user, method, path, body) {
  const pending = [];
  const res = await worker.fetch(new Request(`https://bot.test${path}`, {
    method,
    headers: { "content-type": "application/json", Authorization: `tma ${await initDataFor(bot, user)}` },
    body: body ? JSON.stringify(body) : undefined
  }), bot.env, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
  return { status: res.status, body: await res.json() };
}

const withBot = fn => async () => {
  const bot = new Bot();
  try { await fn(bot); } finally { await sleep(60); bot.close(); }
};

const book = (bot, user, name, time = "18:00") => api(bot, user, "POST", "/api/book", { branch: "P03", date: TUE, time, child_name: name });
const cancel = (bot, user, id, confirm) => api(bot, user, "POST", "/api/cancel", { branch: "P03", booking_id: id, ...(confirm ? { confirm_late: true } : {}) });
const panelText = bot => bot.panelMessage().text;
const LATE_LINE = "⚠️ Поздняя отмена: Эвелина (менее 3 часов до занятия)";

async function resync(bot) {
  bot.sql(`INSERT INTO outbox (event_type, dedupe_key, payload, priority, status, attempts, next_attempt_at, created_at, updated_at)
           VALUES ('panel_sync', NULL, '{}', 2, 'pending', 0, 0, 0, 0)`);
  await bot.admin("POST", "/admin/drain?branch=P03");
  await bot.settle();
}

test("LC1. За 3 часа и больше — обычная отмена без предупреждения, в панели нет строки о поздней отмене", withBot(async bot => {
  await bot.init();
  const id = (await book(bot, U.A, "Эвелина")).body.booking.id;
  bot.clock.now = START_18 - 3 * HOUR - 60_000;
  const r = await cancel(bot, U.A, id);
  await bot.settle();
  assert.equal(r.status, 200);
  assert.equal(r.body.late, false);
  assert.equal(bot.sql("SELECT status FROM bookings")[0].status, "cancelled");
  assert.doesNotMatch(panelText(bot), /Поздняя отмена/);
}));

test("LC2. Ровно за 3 часа — ещё обычная отмена", withBot(async bot => {
  await bot.init();
  const id = (await book(bot, U.A, "Эвелина")).body.booking.id;
  bot.clock.now = START_18 - 3 * HOUR;
  const r = await cancel(bot, U.A, id);
  await bot.settle();
  assert.equal(r.status, 200);
  assert.equal(r.body.late, false);
  assert.doesNotMatch(panelText(bot), /Поздняя отмена/);
}));

test("LC3. Менее 3 часов: сначала предупреждение (запись не тронута), после подтверждения — поздняя отмена", withBot(async bot => {
  await bot.init();
  const id = (await book(bot, U.A, "Эвелина")).body.booking.id;
  await book(bot, U.B, "Максим");
  bot.clock.now = START_18 - 3 * HOUR + 1000;

  const warn = await cancel(bot, U.A, id);                       // без подтверждения
  assert.equal(warn.status, 409);
  assert.equal(warn.body.code, "late_confirm_required");
  assert.equal(warn.body.message, WARNING);
  assert.equal(bot.sql("SELECT status FROM bookings WHERE id = ?", id)[0].status, "active", "до подтверждения ничего не изменилось");

  const done = await cancel(bot, U.A, id, true);
  await bot.settle();
  assert.equal(done.status, 200);
  assert.equal(done.body.late, true);
  assert.match(done.body.message, /считается использованным/);

  const row = bot.sql("SELECT * FROM bookings WHERE id = ?", id)[0];
  assert.equal(row.status, "cancelled");
  assert.equal(row.cancelled_at, bot.clock.now, "время отмены сохранено");
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM booking_events WHERE booking_id = ? AND event = 'cancelled' AND at = ?", id, row.cancelled_at)[0].c, 1);
  assert.equal(bot.activeCount(TUE, "18:00"), 1, "поздняя отмена не считается активной записью");

  assert.ok(panelText(bot).includes(`18:00\n• Максим\n${LATE_LINE}`), panelText(bot));
  assert.doesNotMatch(panelText(bot), /• Эвелина/);
}));

test("LC4. Строка поздней отмены сохраняется при следующих обновлениях панели и исчезает после начала занятия; событие остаётся", withBot(async bot => {
  await bot.init();
  const id = (await book(bot, U.A, "Эвелина")).body.booking.id;
  bot.clock.now = START_18 - 2 * HOUR;
  await cancel(bot, U.A, id, true);
  await bot.settle();
  assert.match(panelText(bot), /⚠️ Поздняя отмена: Эвелина/);

  await book(bot, U.B, "Максим", "19:00");                        // другое изменение → панель публикуется заново
  await bot.settle();
  assert.ok(panelText(bot).includes(`18:00\n${LATE_LINE}\n\n19:00\n• Максим`), panelText(bot));

  bot.clock.now = START_18 + 60_000;                              // занятие началось
  await resync(bot);
  assert.doesNotMatch(panelText(bot), /Эвелина/, "после начала занятия строка пропадает");
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM booking_events WHERE booking_id = ? AND event = 'cancelled'", id)[0].c, 1, "событие в истории осталось");
}));

test("LC5. Флаг late в «Мои записи» и в расписании; отмена чужой записи по-прежнему запрещена", withBot(async bot => {
  await bot.init();
  const id = (await book(bot, U.A, "Эвелина")).body.booking.id;
  let my = await api(bot, U.A, "GET", "/api/my");
  assert.equal(my.body.bookings[0].late, false);
  bot.clock.now = START_18 - 2 * HOUR;
  my = await api(bot, U.A, "GET", "/api/my");
  assert.equal(my.body.bookings[0].late, true);
  const sched = await api(bot, U.A, "GET", "/api/schedule?branch=P03");
  assert.equal(sched.body.days[0].slots[0].children[0].late, true);
  assert.equal((await cancel(bot, U.B, id, true)).body.code, "not_owner");
  assert.equal(bot.sql("SELECT status FROM bookings")[0].status, "active");
}));

test("LC6. В боте поздняя отмена кнопкой не выполняется: подсказка про приложение, запись цела", withBot(async bot => {
  await bot.init();
  const { confirmation } = await bot.book(U.A, TUE, "18:00", "Эвелина");
  bot.clock.now = START_18 - 2 * HOUR;
  await bot.press(U.A, confirmation.reply_markup.inline_keyboard[0][0].callback_data, structuredClone(confirmation));
  assert.match(bot.lastAnswer(), /менее 3 часов/);
  assert.equal(bot.sql("SELECT status FROM bookings")[0].status, "active");
  void GROUP;
}));
