/**
 * Три ближайшие даты тренировок (по реальному расписанию филиала, московское время) и минималистичный формат панели.
 * Ограничение действует и на сервере: запись на четвёртую и дальнейшие даты невозможна.
 */
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { BRANCHES, upcomingTrainingDates, PANEL_HEADER } from "../src/branch-do.js";
import { Bot, U, GROUP, CHAT_ID } from "./harness.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = new TextEncoder();
const P03 = BRANCHES.P03;       // вс 12:00/13:00, вт и чт 18:00/19:00
const at = iso => Date.parse(iso);

const withBot = fn => async () => {
  const bot = new Bot();
  try { await fn(bot); } finally { await sleep(60); bot.close(); }
};

async function hmacRaw(keyBytes, data) {
  const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

async function api(bot, user, method, path, body) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(bot.clock.now / 1000)), query_id: "AAH", user: JSON.stringify({ id: user.id, first_name: user.first_name })
  });
  const check = [...params].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = await hmacRaw(enc.encode("WebAppData"), bot.env.BOT_TOKEN);
  params.set("hash", [...(await hmacRaw(secret, check))].map(b => b.toString(16).padStart(2, "0")).join(""));
  const pending = [];
  const res = await worker.fetch(new Request(`https://bot.test${path}`, {
    method, headers: { "content-type": "application/json", Authorization: `tma ${params}` }, body: body ? JSON.stringify(body) : undefined
  }), bot.env, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
  return { status: res.status, body: await res.json() };
}

const book = (bot, user, date, time, name) => api(bot, user, "POST", "/api/book", { branch: "P03", date, time, child_name: name });

test("T1. Ближайшие три даты по расписанию Пролетарской, московское время, смена после последнего занятия дня", () => {
  const d = iso => upcomingTrainingDates(P03, at(iso));
  assert.deepEqual(d("2026-11-10T09:00:00+03:00"), ["2026-11-10", "2026-11-12", "2026-11-15"], "вторник утром: вт, чт, вс");
  assert.deepEqual(d("2026-11-10T18:30:00+03:00"), ["2026-11-10", "2026-11-12", "2026-11-15"], "вторник 18:30: 19:00 ещё впереди — день сохраняется");
  assert.deepEqual(d("2026-11-10T19:01:00+03:00"), ["2026-11-10", "2026-11-12", "2026-11-15"], "вторник остаётся в окне после последнего занятия до полуночи");
  assert.deepEqual(d("2026-11-15T12:30:00+03:00"), ["2026-11-15", "2026-11-17", "2026-11-19"], "воскресенье 12:30: 13:00 ещё впереди");
  assert.deepEqual(d("2026-11-15T13:30:00+03:00"), ["2026-11-15", "2026-11-17", "2026-11-19"], "воскресенье остаётся в окне после последнего занятия");
  assert.deepEqual(d("2026-11-15T23:59:59+03:00"), ["2026-11-15", "2026-11-17", "2026-11-19"], "последняя секунда воскресенья по Москве");
  assert.deepEqual(d("2026-11-16T00:00:00+03:00"), ["2026-11-17", "2026-11-19", "2026-11-22"], "ровно в полночь окно переключается");
  assert.deepEqual(d("2026-11-16T10:00:00+03:00"), ["2026-11-17", "2026-11-19", "2026-11-22"], "понедельник: вт, чт, вс");
  assert.deepEqual(d("2026-11-17T23:59:59+03:00"), ["2026-11-17", "2026-11-19", "2026-11-22"], "вторник остаётся до конца дня");
  assert.deepEqual(d("2026-11-18T00:00:00+03:00"), ["2026-11-19", "2026-11-22", "2026-11-24"], "в среду окно начинается со следующего дня тренировок");
  // UTC instant переводится в московскую календарную дату до выбора тренировок.
  assert.deepEqual(d("2026-11-15T20:59:59Z"), ["2026-11-15", "2026-11-17", "2026-11-19"]);
  assert.deepEqual(d("2026-11-15T21:00:00Z"), ["2026-11-17", "2026-11-19", "2026-11-22"]);
  assert.equal(JSON.stringify(P03.schedule), JSON.stringify({ 2: ["18:00", "19:00"], 4: ["18:00", "19:00"], 0: ["12:00", "13:00"] }), "расписание филиала не менялось");
});

test("T2. Расписание в API — ровно три даты; запись на четвёртую отклоняется на сервере (Mini App и бот)", withBot(async bot => {
  const s = await api(bot, U.A, "GET", "/api/schedule?branch=P03");
  assert.deepEqual(s.body.days.map(x => x.date), ["2026-11-10", "2026-11-12", "2026-11-15"]);

  assert.equal((await book(bot, U.A, "2026-11-15", "13:00", "Витя")).body.code, "booked", "третья дата доступна");
  const fourth = await book(bot, U.A, "2026-11-17", "18:00", "Ярик");
  assert.equal(fourth.status, 409);
  assert.equal(fourth.body.code, "slot_closed");
  assert.equal((await book(bot, U.A, "2026-11-24", "18:00", "Ярик")).body.code, "slot_closed");
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM bookings")[0].c, 1);

  await bot.init();
  await bot.press(U.B, "book|P03|2026-11-17|18:00", { message_id: 1, chat: GROUP, text: "x" });
  assert.match(bot.lastAnswer(), /недоступно/);
  assert.equal(bot.promptFor(U.B), null);

  bot.clock.now = at("2026-11-10T19:30:00+03:00");                 // вторник остаётся в окне до конца календарного дня
  const next = await api(bot, U.A, "GET", "/api/schedule?branch=P03");
  assert.deepEqual(next.body.days.map(x => x.date), ["2026-11-10", "2026-11-12", "2026-11-15"]);
  assert.ok(next.body.days[0].slots.every(slot => slot.open === false), "слоты завершившегося дня закрыты");
  assert.equal((await book(bot, U.A, "2026-11-17", "18:00", "Ярик")).body.code, "slot_closed", "четвёртая дата пока недоступна");

  bot.clock.now = at("2026-11-11T00:00:00+03:00");
  const afterMidnight = await api(bot, U.A, "GET", "/api/schedule?branch=P03");
  assert.deepEqual(afterMidnight.body.days.map(x => x.date), ["2026-11-12", "2026-11-15", "2026-11-17"]);
  assert.equal((await book(bot, U.A, "2026-11-17", "18:00", "Ярик")).body.code, "booked", "дата доступна после переключения окна");
  assert.equal((await book(bot, U.A, "2026-11-19", "18:00", "Ярик")).body.code, "slot_closed");
}));

test("T5. Окно дат на границе суток в API, при этом начавшиеся слоты остаются закрыты", withBot(async bot => {
  bot.clock.now = at("2026-11-15T23:59:59+03:00");
  const sunday = await api(bot, U.A, "GET", "/api/schedule?branch=P03");
  assert.deepEqual(sunday.body.days.map(x => x.date), ["2026-11-15", "2026-11-17", "2026-11-19"]);
  assert.ok(sunday.body.days[0].slots.every(slot => slot.open === false));
  assert.equal((await book(bot, U.A, "2026-11-15", "12:00", "Виктор")).body.code, "slot_closed");

  bot.clock.now = at("2026-11-16T00:00:00+03:00");
  const monday = await api(bot, U.A, "GET", "/api/schedule?branch=P03");
  assert.deepEqual(monday.body.days.map(x => x.date), ["2026-11-17", "2026-11-19", "2026-11-22"]);
}));
test("T3. Минималистичный формат панели: без счётчиков и пустых занятий, дни и время разделены", withBot(async bot => {
  await bot.init();
  await book(bot, U.A, "2026-11-15", "12:00", "Вася");
  await book(bot, U.B, "2026-11-15", "12:00", "Агата");
  await book(bot, U.A, "2026-11-15", "13:00", "Витя");
  await book(bot, U.C, "2026-11-12", "18:00", "Ярик");
  await bot.settle();

  const sep = "───────────────";
  assert.equal(bot.panelMessage().text, [
    "PRIDE ONE · Пролетарская", sep, "",
    "Четверг, 12 ноября", "", "18:00", "• Ярик", "", sep, "",
    "Воскресенье, 15 ноября", "", "12:00", "• Вася", "• Агата", "", "13:00", "• Витя"
  ].join("\n"));
  assert.ok(bot.panelMessage().text.startsWith(PANEL_HEADER));
  assert.doesNotMatch(bot.panelMessage().text, /детей|ребён|Филиал:|Пока нет|Период|\d\./);
  assert.equal(bot.panelMessage().reply_markup.inline_keyboard[0][0].text, "📲 Открыть приложение PRIDE ONE", "кнопка сохранена");
  assert.equal(bot.tg.chatMessages(CHAT_ID).filter(m => (m.text || "").startsWith(PANEL_HEADER)).length, 1);
}));

test("T4. Поздняя отмена показывается отдельной строкой под своим временем", withBot(async bot => {
  await bot.init();
  const id = (await book(bot, U.A, "2026-11-10", "18:00", "Эвелина")).body.booking.id;
  await book(bot, U.B, "2026-11-10", "18:00", "Максим");
  bot.clock.now = at("2026-11-10T16:00:00+03:00");
  await api(bot, U.A, "POST", "/api/cancel", { branch: "P03", booking_id: id, confirm_late: true });
  await bot.settle();
  assert.ok(bot.panelMessage().text.endsWith("18:00\n• Максим\n⚠️ Поздняя отмена: Эвелина (менее 3 часов до занятия)"), bot.panelMessage().text);
}));
