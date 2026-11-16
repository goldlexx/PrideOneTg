/**
 * Mini App API: подпись initData, членство, запись, дубль, список участников, отмена.
 * Минимальный набор ключевых сценариев (M1–M10).
 */
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { verifyInitData } from "../src/miniapp.js";
import { Bot, U, TUE } from "./harness.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = new TextEncoder();

async function hmacRaw(keyBytes, data) {
  const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

/** Строит подписанный initData так, как это делает Telegram. */
async function initDataFor(bot, user, { authDate = Math.floor(bot.clock.now / 1000), tamper = false } = {}) {
  const params = new URLSearchParams({
    auth_date: String(authDate), query_id: "AAH", user: JSON.stringify({ id: user.id, first_name: user.first_name })
  });
  const check = [...params].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = await hmacRaw(enc.encode("WebAppData"), bot.env.BOT_TOKEN);
  const sig = await hmacRaw(secret, check);
  params.set("hash", [...sig].map(b => b.toString(16).padStart(2, "0")).join(""));
  if (tamper) params.set("user", JSON.stringify({ id: 999, first_name: "Хакер" }));
  return params.toString();
}

async function api(bot, user, method, path, body, opts) {
  const pending = [];
  const headers = { "content-type": "application/json" };
  if (user) headers.Authorization = `tma ${await initDataFor(bot, user, opts)}`;
  const res = await worker.fetch(
    new Request(`https://bot.test${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }),
    bot.env, { waitUntil: p => pending.push(p) }
  );
  await Promise.all(pending);
  return { status: res.status, body: await res.json() };
}

const withBot = fn => async () => {
  const bot = new Bot();
  try { await fn(bot); } finally { await sleep(60); bot.close(); }
};

const book = (bot, user, name, time = "18:00", date = TUE) =>
  api(bot, user, "POST", "/api/book", { branch: "P03", date, time, child_name: name });

test("M1. Подпись: верная принимается, подделка и устаревшая отвергаются", withBot(async bot => {
  const ok = await verifyInitData(await initDataFor(bot, U.A), bot.env.BOT_TOKEN, bot.clock.now);
  assert.equal(ok.ok, true);
  assert.equal(ok.user.id, "101");
  assert.equal((await verifyInitData(await initDataFor(bot, U.A, { tamper: true }), bot.env.BOT_TOKEN, bot.clock.now)).reason, "bad_signature");
  assert.equal((await verifyInitData(await initDataFor(bot, U.A, { authDate: 1000 }), bot.env.BOT_TOKEN, bot.clock.now)).reason, "expired");
  assert.equal((await verifyInitData("", bot.env.BOT_TOKEN)).ok, false);
}));

test("M2. Без подписи и с подделанным user — 401, ничего не создаётся", withBot(async bot => {
  assert.equal((await api(bot, null, "GET", "/api/branches")).status, 401);
  const forged = await worker.fetch(new Request("https://bot.test/api/book", {
    method: "POST",
    headers: { Authorization: `tma ${await initDataFor(bot, U.A, { tamper: true })}` },
    body: JSON.stringify({ branch: "P03", date: TUE, time: "18:00", child_name: "Маша", user_id: 101 })
  }), bot.env, { waitUntil() {} });
  assert.equal(forged.status, 401);
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM bookings")[0].c, 0);
}));

test("M3. Филиалы и расписание: только подключённые филиалы, будущие занятия", withBot(async bot => {
  const b = await api(bot, U.A, "GET", "/api/branches");
  assert.deepEqual(b.body.branches, [{ id: "P03", name: "Пролетарская" }]);
  const s = await api(bot, U.A, "GET", "/api/schedule?branch=P03");
  assert.equal(s.status, 200);
  assert.equal(s.body.days[0].date, TUE);
  assert.deepEqual(s.body.days[0].slots.map(x => x.time), ["18:00", "19:00"]);
  assert.equal((await api(bot, U.A, "GET", "/api/schedule?branch=XX")).status, 403);
}));

test("M4. Запись: общая логика, дубль отклоняется, имя и время проверяются", withBot(async bot => {
  const r = await book(bot, U.A, "  Маша  ");
  assert.equal(r.status, 200);
  assert.equal(r.body.code, "booked");
  const dup = await book(bot, U.A, "маша");
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "duplicate");
  assert.equal((await book(bot, U.A, "1")).body.code, "bad_name");
  assert.equal((await book(bot, U.A, "Петя", "17:00")).body.code, "slot_closed");
  assert.equal((await book(bot, U.A, "Петя", "18:00", "2026-11-09")).body.code, "slot_closed");
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM bookings WHERE status='active'")[0].c, 1);
}));

test("M5. Список участников виден другим родителям; без телефонов и id", withBot(async bot => {
  await book(bot, U.A, "Маша");
  await book(bot, U.B, "Ваня");
  const s = await api(bot, U.C, "GET", "/api/schedule?branch=P03");
  const slot = s.body.days[0].slots[0];
  assert.equal(slot.count, 2);
  assert.deepEqual(slot.children.map(c => c.name).sort(), ["Ваня", "Маша"]);
  assert.ok(slot.children.every(c => c.mine === false && !c.booking_id));
  assert.ok(!/"101"|"202"|parent/i.test(JSON.stringify(s.body)), "в ответе нет id родителей");
  const a = await api(bot, U.A, "GET", "/api/schedule?branch=P03");
  assert.equal(a.body.days[0].slots[0].children.find(c => c.name === "Маша").mine, true);
}));

test("M6. Мои записи: только свои будущие", withBot(async bot => {
  await book(bot, U.A, "Маша");
  await book(bot, U.B, "Ваня");
  const my = await api(bot, U.A, "GET", "/api/my");
  assert.deepEqual(my.body.bookings.map(x => x.child_name), ["Маша"]);
  assert.equal(my.body.bookings[0].time, "18:00");
}));

test("M7. Отмена: чужую нельзя, свою можно, повторная — отказ", withBot(async bot => {
  const id = (await book(bot, U.A, "Маша")).body.booking.id;
  assert.equal((await api(bot, U.B, "POST", "/api/cancel", { branch: "P03", booking_id: id })).body.code, "not_owner");
  assert.equal(bot.sql("SELECT status FROM bookings")[0].status, "active");
  const mine = await api(bot, U.A, "POST", "/api/cancel", { branch: "P03", booking_id: id });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.code, "cancelled");
  assert.equal((await api(bot, U.A, "POST", "/api/cancel", { branch: "P03", booking_id: id })).body.code, "already");
  assert.equal((await api(bot, U.A, "GET", "/api/my")).body.bookings.length, 0);
}));

test("M8. Отмена в Mini App не шлёт уведомление в группу: только обновляется панель", withBot(async bot => {
  await bot.init();
  const id = (await book(bot, U.A, "Маша")).body.booking.id;
  await api(bot, U.A, "POST", "/api/cancel", { branch: "P03", booking_id: id });
  await api(bot, U.A, "POST", "/api/cancel", { branch: "P03", booking_id: id });
  await bot.settle();
  assert.equal(bot.notices(/Запись отменена/).length, 0, "отдельного уведомления об отмене нет");
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM outbox WHERE event_type = 'cancel_notice'")[0].c, 0);
  assert.equal(bot.boards(TUE).length, 1, "в чате одно информационное сообщение — панель");
  assert.doesNotMatch(bot.board(TUE), /18:00\n/, "пустое занятие не показывается");
}));

test("M11. Временный сбой getChatMember (502) не блокирует участника: следующий запрос проходит сразу", withBot(async bot => {
  const fresh = { id: 90001, first_name: "Новый" };       // нет в кеше членства от других тестов
  bot.tg.failNext("getChatMember", { code: 502, description: "Bad Gateway" });
  const first = await api(bot, fresh, "GET", "/api/branches");
  assert.equal(first.status, 503);
  assert.equal(first.body.code, "telegram_unavailable");
  const second = await api(bot, fresh, "GET", "/api/branches");
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.branches, [{ id: "P03", name: "Пролетарская" }], "отрицательный ответ не закеширован");
}));

test("M9. Занятие началось — отмена недоступна", withBot(async bot => {
  const id = (await book(bot, U.A, "Маша")).body.booking.id;
  bot.advance(10 * 3600 * 1000);
  assert.equal((await api(bot, U.A, "POST", "/api/cancel", { branch: "P03", booking_id: id })).body.code, "started");
}));

test("M10. Запись из Mini App попадает в панель группы", withBot(async bot => {
  await bot.init();
  await book(bot, U.A, "Маша");
  await bot.settle();
  const texts = bot.tg.calls.filter(c => ["sendMessage", "editMessageText"].includes(c.method)).map(c => c.p.text || "").join("\n");
  assert.match(texts, /• Маша/);
}));
