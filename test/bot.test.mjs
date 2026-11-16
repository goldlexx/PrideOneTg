import test from "node:test";
import assert from "node:assert/strict";
import { Bot, U, ADMIN, GROUP, CHAT_ID, OTHER_CHAT_ID, BOT_ID, TUE, THU, SUN, CONFIRM_HEADER, BOARD_HEADER, PANEL_HEADER } from "./harness.mjs";

const re = s => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
function withBot(fn) {
  return async () => {
    const bot = new Bot();
    try { await fn(bot); } finally { bot.close(); }
  };
}
const ready = async bot => { await bot.init(); assert.ok(bot.panelMessage(), "панель опубликована"); };

/* ----------------------------- A–H: основные ------------------------------ */

test("A. Первая запись: бронь, подтверждение, общее сообщение дня с одним ребёнком", withBot(async bot => {
  await ready(bot);
  const { confirmation } = await bot.book(U.A, TUE, "18:00", "Артём");
  assert.ok(confirmation, "подтверждение отправлено");
  assert.equal(bot.activeCount(TUE, "18:00"), 1);
  assert.match(bot.board(TUE), /18:00\n• Артём\n/);
  assert.equal(bot.panelCount(TUE, "18:00"), 1);
  assert.equal(bot.promptFor(U.A), null, "форма записи удалена после записи");
}));

test("B. Вторая запись другого родителя на тот же слот — первое имя остаётся", withBot(async bot => {
  await ready(bot);
  await bot.book(U.A, TUE, "18:00", "Артём");
  await bot.book(U.B, TUE, "18:00", "Максим");
  assert.match(bot.board(TUE), /18:00\n• Артём\n• Максим\n/);
  assert.equal(bot.panelCount(TUE, "18:00"), 2);
}));

test("C. Запись на другое время — оба слота в одном общем сообщении", withBot(async bot => {
  await ready(bot);
  await bot.book(U.A, TUE, "18:00", "Артём");
  await bot.book(U.B, TUE, "18:00", "Максим");
  await bot.book(U.C, TUE, "19:00", "София");
  const text = bot.board(TUE);
  assert.match(text, /18:00\n• Артём\n• Максим\n/);
  assert.match(text, /19:00\n• София\n/);
  assert.equal(bot.panelCount(TUE, "19:00"), 1);
}));

test("D. Отмена из подтверждения: имя исчезает, счётчики уменьшаются, подтверждение меняется", withBot(async bot => {
  await ready(bot);
  await bot.book(U.A, TUE, "18:00", "Артём");
  const { confirmation } = await bot.book(U.B, TUE, "18:00", "Максим");
  const btn = confirmation.reply_markup.inline_keyboard[0][0];
  await bot.press(U.B, btn.callback_data, confirmation);
  assert.equal(bot.lastAnswer(), "Запись отменена");
  assert.match(bot.board(TUE), /18:00\n• Артём\n/);
  assert.doesNotMatch(bot.board(TUE), /Максим/);
  assert.equal(bot.panelCount(TUE, "18:00"), 1);
  assert.match(bot.tg.messages.get(`${CHAT_ID}:${confirmation.message_id}`).text, /^Запись отменена/);
  assert.equal(bot.sql("SELECT status FROM bookings WHERE child_name = 'Максим'")[0].status, "cancelled");
}));

test("E. Повторная запись того же ребёнка после отмены", withBot(async bot => {
  await ready(bot);
  const first = await bot.book(U.B, TUE, "18:00", "Максим");
  await bot.press(U.B, first.confirmation.reply_markup.inline_keyboard[0][0].callback_data, first.confirmation);
  assert.equal(bot.activeCount(TUE, "18:00"), 0);
  const again = await bot.book(U.B, TUE, "18:00", "Максим");
  assert.ok(again.confirmation, "новое подтверждение");
  assert.equal(bot.activeCount(TUE, "18:00"), 1);
  assert.match(bot.board(TUE), /18:00\n• Максим\n/);
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM bookings WHERE child_name = 'Максим'")[0].c, 2, "история: отменённая + новая");
}));

test("F. «Мои записи»: только свои, чужую отменить нельзя, список обновляется после отмены", withBot(async bot => {
  await ready(bot);
  const artem = await bot.book(U.A, TUE, "18:00", "Артём");
  await bot.book(U.A, THU, "19:00", "Артём");
  await bot.book(U.B, TUE, "18:00", "Максим");

  await bot.press(U.A, "mine|P03");
  let list = bot.myLists().at(-1);
  assert.match(list.text, /Родитель: Анна/);
  assert.equal((list.text.match(/— Артём/g) || []).length, 2);
  assert.doesNotMatch(list.text, /Максим/);

  const btn = list.reply_markup.inline_keyboard.flat().find(b => b.text.includes("Вт 10.11"));
  await bot.press(U.B, btn.callback_data, list);
  assert.match(bot.lastAnswer(), /только родитель/);
  assert.equal(bot.activeCount(TUE, "18:00"), 2, "чужая бронь не отменена");

  await bot.press(U.A, btn.callback_data, list);
  list = bot.tg.messages.get(`${CHAT_ID}:${list.message_id}`);
  assert.equal((list.text.match(/— Артём/g) || []).length, 1, "список обновлён");
  assert.match(list.text, /12 ноября/);
  assert.match(bot.board(TUE), /18:00\n• Максим\n/);
  assert.match(bot.tg.messages.get(`${CHAT_ID}:${artem.confirmation.message_id}`).text, /^Запись отменена/, "старое подтверждение помечено");
}));

test("G. Два ребёнка одного родителя на одно занятие, отмена независимо", withBot(async bot => {
  await ready(bot);
  const vanya = await bot.book(U.D, TUE, "19:00", "Ваня");
  const petya = await bot.book(U.D, TUE, "19:00", "Петя");
  assert.match(bot.board(TUE), /19:00\n• Ваня\n• Петя\n/);
  await bot.press(U.D, vanya.confirmation.reply_markup.inline_keyboard[0][0].callback_data, vanya.confirmation);
  assert.match(bot.board(TUE), /19:00\n• Петя\n/);
  await bot.press(U.D, petya.confirmation.reply_markup.inline_keyboard[0][0].callback_data, petya.confirmation);
  assert.doesNotMatch(bot.board(TUE), /19:00\n/, "пустое занятие не показывается");
}));

test("H. Дубль одного ребёнка (в т.ч. другой регистр и «ё»/«е») не создаётся, бот объясняет", withBot(async bot => {
  await ready(bot);
  await bot.book(U.A, TUE, "18:00", "Алёна");
  bot.advance(3 * 60 * 1000);
  const second = await bot.book(U.A, TUE, "18:00", "  алена ");
  assert.equal(second.confirmation, null);
  assert.equal(bot.activeCount(TUE, "18:00"), 1);
  assert.equal(bot.notices(/уже записан\(а\)/).length, 1);
  assert.equal((bot.board(TUE).match(/Алёна/g) || []).length, 1);
}));

/* ------------------------- I–J: конкурентность ---------------------------- */

test("I1. 10 родителей одновременно открывают формы и одновременно отвечают — 10 броней", withBot(async bot => {
  await ready(bot);
  const parents = Array.from({ length: 10 }, (_, i) => ({ id: 1000 + i, first_name: `Родитель${i}`, is_bot: false }));
  const panel = bot.panelMessage();

  await Promise.all(parents.map(p => bot.press(p, `book|P03|${TUE}|18:00`, panel)));
  const prompts = parents.map(p => bot.promptFor(p));
  assert.ok(prompts.every(Boolean), "все 10 форм отправлены");

  const results = await Promise.all(parents.map((p, i) => bot.send(bot.replyUpdate(p, prompts[i], `Ребёнок${i}`))));
  assert.ok(results.every(r => r.status === 200));
  await bot.settle();

  assert.equal(bot.activeCount(TUE, "18:00"), 10);
  assert.equal(bot.panelCount(TUE, "18:00"), 10);
  for (let i = 0; i < 10; i++) assert.match(bot.board(TUE), re(`• Ребёнок${i}\n`));
  assert.equal(bot.panelCount(TUE, "18:00"), 10);
  assert.equal(bot.tg.chatMessages(CHAT_ID).filter(m => m.text?.startsWith(CONFIRM_HEADER)).length, 10);
  assert.equal(bot.outbox("pending").length + bot.outbox("sending").length + bot.outbox("failed").length, 0);
}));

test("I2. Один родитель: 5 форм на один слот, 5 одновременных ответов одним именем — ровно 1 бронь", withBot(async bot => {
  await ready(bot);
  const prompts = [];
  for (let i = 0; i < 5; i++) {
    prompts.push(await bot.openPrompt(U.A, TUE, "18:00"));
    bot.advance(2 * 60 * 1000 + 1000);
  }
  assert.equal(new Set(prompts.map(p => p.message_id)).size, 5);
  await Promise.all(prompts.map(p => bot.send(bot.replyUpdate(U.A, p, "Артём"))));
  await bot.settle();
  assert.equal(bot.activeCount(TUE, "18:00"), 1);
  assert.equal(bot.notices(/уже записан\(а\)/).length, 4);
  assert.match(bot.board(TUE), /18:00\n• Артём\n/);
}));

test("J. Повторная доставка одного update_id (параллельно и позже) — одна бронь", withBot(async bot => {
  await ready(bot);
  const prompt = await bot.openPrompt(U.A, TUE, "18:00");
  const update = bot.replyUpdate(U.A, prompt, "Артём");
  update.update_id = 900001;

  const [r1, r2] = await Promise.all([bot.send(structuredClone(update)), bot.send(structuredClone(update))]);
  const r3 = await bot.send(structuredClone(update));
  assert.deepEqual([r1.status, r2.status, r3.status], [200, 200, 200]);
  assert.equal([r1, r2, r3].filter(r => r.body.duplicate).length, 2);
  assert.equal(bot.activeCount(TUE, "18:00"), 1);
  assert.equal(bot.confirmations("Артём").length, 1);

  // Повтор нажатия кнопки «записаться» с тем же update_id — одна форма.
  const cb = bot.callback(U.B, `book|P03|${TUE}|19:00`, bot.panelMessage());
  cb.update_id = 900002;
  await Promise.all([bot.send(structuredClone(cb)), bot.send(structuredClone(cb))]);
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM pending_prompts WHERE parent_id = '202'")[0].c, 1);
}));

/* ------------------------ K–O: сбои и восстановление ---------------------- */

test("K1. Worker прервался после сохранения брони, объект перезапущен — подтверждение отправит будильник", withBot(async bot => {
  await ready(bot);
  const prompt = await bot.openPrompt(U.A, TUE, "18:00");
  await bot.send(bot.replyUpdate(U.A, prompt, "Артём"), { background: "drop" });
  bot.ns.restart("P03");
  assert.equal(bot.activeCount(TUE, "18:00"), 1, "бронь сохранена до отправки сообщений");

  await bot.advanceAndSettle(6000);
  assert.equal(bot.confirmations("Артём").length, 1);
  assert.match(bot.board(TUE), /• Артём/);
  assert.equal(bot.outbox("pending").length, 0);
}));

test("K2. Объект «упал» во время отправки подтверждения (зависший запрос) — после аренды повтор, 1 подтверждение", withBot(async bot => {
  await ready(bot);
  const prompt = await bot.openPrompt(U.A, TUE, "18:00");
  bot.tg.failNext("sendMessage", "hang", { when: p => p.text?.startsWith(CONFIRM_HEADER) });
  await bot.send(bot.replyUpdate(U.A, prompt, "Артём"), { background: "drop" });
  await new Promise(r => setTimeout(r, 50));
  bot.ns.restart("P03");
  assert.equal(bot.sql("SELECT status FROM outbox WHERE event_type = 'send_confirmation'")[0].status, "sending");

  await bot.advanceAndSettle(61_000);
  assert.equal(bot.confirmations("Артём").length, 1);
  assert.match(bot.board(TUE), /• Артём/);
}));

test("K3. Потерянный ответ Telegram после успешной отправки — бронь одна, подтверждение может прийти дважды (at-least-once)", withBot(async bot => {
  await ready(bot);
  const prompt = await bot.openPrompt(U.A, TUE, "18:00");
  bot.tg.failNext("sendMessage", "lost", { when: p => p.text?.startsWith(CONFIRM_HEADER) });
  await bot.send(bot.replyUpdate(U.A, prompt, "Артём"));
  assert.equal(bot.confirmations("Артём").length, 1, "сообщение доставлено, но ответ потерян");
  assert.equal(bot.sql("SELECT status FROM outbox WHERE event_type = 'send_confirmation'")[0].status, "pending");

  await bot.advanceAndSettle(3000);
  assert.equal(bot.activeCount(TUE, "18:00"), 1, "бронь не задвоилась");
  assert.equal(bot.confirmations("Артём").length, 2, "известное ограничение Telegram API: повтор отправки");
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM telegram_messages WHERE kind = 'confirmation'")[0].c, 1);
}));

test("L1. Ошибка Telegram 5xx при правке панели — старая панель остаётся, повтор с бэкоффом, данные верны", withBot(async bot => {
  await ready(bot);
  await bot.book(U.A, TUE, "18:00", "Артём");
  bot.tg.failNext("sendMessage", { code: 502, description: "Bad Gateway" }, { when: p => p.text?.startsWith(PANEL_HEADER), times: 2 });
  await bot.book(U.B, TUE, "18:00", "Максим");
  assert.doesNotMatch(bot.board(TUE), /Максим/, "пока Telegram недоступен, панель старая");
  assert.equal(bot.activeCount(TUE, "18:00"), 2, "но данные уже сохранены");
  const row = bot.sql("SELECT * FROM outbox WHERE event_type = 'panel_sync' AND status = 'pending'")[0];
  assert.equal(row.attempts, 1);

  await bot.advanceAndSettle(2100);
  assert.doesNotMatch(bot.board(TUE), /Максим/);
  await bot.advanceAndSettle(4100);
  assert.match(bot.board(TUE), /18:00\n• Артём\n• Максим\n/);
}));

test("L2. Telegram 429 retry_after — исполнитель ждёт и не шлёт запросы во время паузы", withBot(async bot => {
  await ready(bot);
  bot.tg.failNext("sendMessage", { code: 429, description: "Too Many Requests: retry after 7", retry_after: 7 },
    { when: p => p.text?.startsWith(CONFIRM_HEADER) });
  const prompt = await bot.openPrompt(U.A, TUE, "18:00");
  await bot.send(bot.replyUpdate(U.A, prompt, "Артём"));
  const callsAfter429 = bot.tg.calls.length;
  await bot.advanceAndSettle(3000);
  assert.equal(bot.tg.calls.length, callsAfter429, "во время паузы запросов нет");
  await bot.advanceAndSettle(4500);
  assert.equal(bot.confirmations("Артём").length, 1);
  assert.match(bot.board(TUE), /• Артём/);
}));

test("L3. Постоянная ошибка Telegram (400) — задача помечается failed и видна в /admin/status, бронь цела", withBot(async bot => {
  await ready(bot);
  bot.tg.failNext("sendMessage", { code: 400, description: "Bad Request: chat not found" }, { when: p => p.text?.startsWith(CONFIRM_HEADER) });
  await bot.book(U.A, TUE, "18:00", "Артём");
  assert.equal(bot.activeCount(TUE, "18:00"), 1);
  const status = await bot.admin("GET", "/admin/status?branch=P03");
  assert.equal(status.body.status.failed_outbox.length, 1);
  assert.equal(status.body.status.failed_outbox[0].event_type, "send_confirmation");
  assert.match(bot.board(TUE), /• Артём/, "остальные задачи выполнены");
}));

test("N1. Ошибка SQL при создании брони — откат всей транзакции, Worker отвечает 500, повтор update успешен", withBot(async bot => {
  await ready(bot);
  const prompt = await bot.openPrompt(U.A, TUE, "18:00");
  const update = bot.replyUpdate(U.A, prompt, "Артём");
  update.update_id = 777001;
  // Сбой на вставке задачи outbox — уже ПОСЛЕ вставки брони в той же транзакции.
  bot.ns.faults.push({ match: /INSERT OR IGNORE INTO outbox/, remaining: 1 });
  const r1 = await bot.send(structuredClone(update));
  assert.equal(r1.status, 500);
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM bookings")[0].c, 0, "бронь откатилась");
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM telegram_updates WHERE update_id = 777001")[0].c, 0, "update не отмечен");
  assert.equal(bot.sql("SELECT status FROM pending_prompts")[0].status, "open", "форма осталась открытой");

  const r2 = await bot.send(structuredClone(update));
  assert.equal(r2.status, 200);
  assert.equal(bot.activeCount(TUE, "18:00"), 1);
  assert.equal(bot.confirmations("Артём").length, 1);
}));

test("N2. Ошибка SQL при отметке update_id — бизнес-изменение тоже откатывается", withBot(async bot => {
  await ready(bot);
  const prompt = await bot.openPrompt(U.A, TUE, "18:00");
  bot.ns.faults.push({ match: /INSERT INTO telegram_updates/, remaining: 1 });
  const update = bot.replyUpdate(U.A, prompt, "Артём");
  const r1 = await bot.send(structuredClone(update));
  assert.equal(r1.status, 500);
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM bookings")[0].c, 0);
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM outbox WHERE event_type = 'send_confirmation'")[0].c, 0);
  await bot.send(structuredClone(update));
  assert.equal(bot.activeCount(TUE, "18:00"), 1);
}));

test("O. Повторная отмена: второе нажатие безопасно, повтор update игнорируется, чужая отмена по ID запрещена", withBot(async bot => {
  await ready(bot);
  const { confirmation } = await bot.book(U.A, TUE, "18:00", "Артём");
  const data = confirmation.reply_markup.inline_keyboard[0][0].callback_data;
  const bookingId = data.split("|")[1];

  // Чужой родитель «знает» ID и шлёт старую кнопку.
  await bot.press(U.B, `cancel|${bookingId}`, confirmation);
  assert.match(bot.lastAnswer(), /только родитель/);
  assert.equal(bot.activeCount(TUE, "18:00"), 1);

  const cb = bot.callback(U.A, data, confirmation);
  cb.update_id = 555001;
  await bot.send(structuredClone(cb));
  await bot.send(structuredClone(cb));            // повторная доставка того же update
  await bot.press(U.A, data, confirmation);       // второе нажатие (новый update)
  assert.equal(bot.lastAnswer(), "Эта запись уже отменена.");
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM booking_events WHERE event = 'cancelled'")[0].c, 1);
  assert.doesNotMatch(bot.board(TUE), /18:00\n/, "пустое занятие не показывается");
}));

/* ------------------------------- P: миграция ------------------------------ */

function seedLegacy(bot) {
  const kv = bot.kv.store;
  const put = (k, v) => kv.set(k, JSON.stringify(v));
  // Этап 0: session/booking/parent/branch/dayboard
  put(`session:P03:${TUE}:18:00`, ["b1", "b2", "b5", "ghost"]);
  put(`session:P03:${THU}:19:00`, ["b3"]);
  put("booking:b1", { id: "b1", branchId: "P03", date: TUE, time: "18:00", childName: "Тимур", parentId: "101", parentName: "Анна", createdAt: "2026-11-01T10:00:00Z" });
  put("booking:b2", { id: "b2", branchId: "P03", date: TUE, time: "18:00", childName: "Ева", parentId: "202", createdAt: "2026-11-01T11:00:00Z" });
  put("booking:b3", { id: "b3", branchId: "P03", date: THU, time: "19:00", childName: "Лев", parentId: "303", createdAt: "2026-11-02T10:00:00Z" });
  put("booking:b4", { id: "b4", branchId: "P03", date: TUE, time: "19:00", childName: "Сирота", parentId: "404", createdAt: "2026-11-02T12:00:00Z" });
  put("booking:b5", { id: "b5", branchId: "P03", date: TUE, time: "18:00", childName: "тимур", parentId: "101", createdAt: "2026-11-03T10:00:00Z" });
  put("parent:101", ["b1", "b5", "zzz"]);
  // Этап 1: объект дня
  put(`day:P03:${SUN}`, { date: SUN, bookings: [{ id: "b6", date: SUN, time: "12:00", childName: "Мира", parentId: "303", createdAt: "2026-11-04T10:00:00Z" }], rev: 3 });
  put("branch:P03", { chatId: CHAT_ID, panelMessageId: 4242, page: 0 });
  put(`dayboard:P03:${TUE}`, { chatId: CHAT_ID, messageId: 4343 });
  bot.tg.seedMessage(CHAT_ID, 4242, "PRIDE ONE | ЗАПИСЬ\nстарая панель");
  bot.tg.seedMessage(CHAT_ID, 4343, `${BOARD_HEADER}\nстарый список`);
}

test("P1. Миграция KV: пробный прогон ничего не меняет; импорт проверяется; повтор не дублирует", withBot(async bot => {
  seedLegacy(bot);
  const kvBefore = JSON.stringify([...bot.kv.store]);

  const dry = await bot.admin("POST", "/admin/migrate?branch=P03");
  assert.equal(dry.status, 200);
  assert.equal(dry.body.dryRun, true);
  assert.equal(dry.body.report.imported_active, 4);
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM bookings")[0].c, 0, "dry run откатан");

  const real = await bot.admin("POST", "/admin/migrate?branch=P03&dry_run=0");
  assert.equal(real.status, 200, JSON.stringify(real.body));
  const r = real.body.report;
  assert.equal(r.verified, true);
  assert.equal(r.imported_active, 4);       // b1, b2, b3, b6
  assert.equal(r.imported_cancelled, 2);    // b4 (нет в активном списке), b5 (дубль b1)
  assert.equal(r.skipped.length, 1);        // ghost — нет данных брони
  assert.equal(r.parent_index_unknown_ids, 1);
  assert.equal(r.day_boards_mapped, 1);
  assert.equal(r.panel_mapped, true);

  const rows = bot.sql("SELECT id, status FROM bookings ORDER BY id");
  assert.deepEqual(rows.map(x => `${x.id}:${x.status}`), ["b1:active", "b2:active", "b3:active", "b4:cancelled", "b5:cancelled", "b6:active"]);

  await bot.settle();
  assert.match(bot.board(TUE), /18:00\n• Тимур\n• Ева\n/, "общее сообщение дня одно и актуально");
  assert.ok(!bot.tg.messages.has(`${CHAT_ID}:4343`), "старое сообщение дня из KV заменено новым и удалено");
  assert.match(bot.panelMessage().text, /Вторник, 10 ноября/, "панель перерисована");
  assert.ok(!bot.tg.messages.has(`${CHAT_ID}:4242`), "старая панель заменена новой и удалена");
  assert.equal(bot.boards(TUE).length, 1);

  const again = await bot.admin("POST", "/admin/migrate?branch=P03&dry_run=0");
  assert.equal(again.body.alreadyDone, true);
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM bookings")[0].c, 6);
  assert.equal(JSON.stringify([...bot.kv.store]), kvBefore, "KV не изменён");
}));

test("P2. После миграции работают старые кнопки отмены (cancel|id и cancel|date|id)", withBot(async bot => {
  seedLegacy(bot);
  await bot.admin("POST", "/admin/migrate?branch=P03&dry_run=0");
  await bot.settle();
  const fakeMsg = { message_id: 1, chat: GROUP, text: "Запись подтверждена.\n\nстарое" };
  await bot.press(U.A, "cancel|b1", fakeMsg);
  assert.equal(bot.lastAnswer(), "Запись отменена");
  await bot.press(U.C, `cancel|${SUN}|b6`, fakeMsg);
  assert.equal(bot.lastAnswer(), "Запись отменена");
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM bookings WHERE status = 'active'")[0].c, 2);
  assert.match(bot.board(TUE), /18:00\n• Ева\n/);
}));

test("P3. Ошибка SQL во время миграции — откат целиком, отметки о миграции нет", withBot(async bot => {
  seedLegacy(bot);
  bot.ns.faults.push({ match: /INSERT INTO booking_events/, remaining: 3 });
  const res = await bot.admin("POST", "/admin/migrate?branch=P03&dry_run=0");
  assert.equal(res.status, 500);
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM bookings")[0].c, 0);
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM meta WHERE key = 'migration:kv_v1'")[0].c, 0);
  bot.ns.faults.length = 0;
  const ok = await bot.admin("POST", "/admin/migrate?branch=P03&dry_run=0");
  assert.equal(ok.body.report.verified, true);
}));

/* ------------------------- доступ и прочие проверки ----------------------- */

test("S1. Webhook без верного секрета отклоняется", withBot(async bot => {
  const r = await bot.send(bot.message(ADMIN, "/init P03"), { secret: "wrong" });
  assert.equal(r.status, 401);
  assert.equal(bot.panelMessage(), null);
}));

test("S2. /init: личный чат, чужая группа, не администратор — панель не публикуется", withBot(async bot => {
  await bot.send({ message: { message_id: 1, chat: { id: ADMIN.id, type: "private" }, from: ADMIN, text: "/init P03" } });
  await bot.send({ message: { message_id: 2, chat: { id: OTHER_CHAT_ID, type: "supergroup" }, from: ADMIN, text: "/init P03" } });
  await bot.init(U.A);
  assert.equal(bot.panelMessage(), null);
  assert.ok(bot.tg.chatMessages(ADMIN.id).some(m => /только в группе/.test(m.text)));
  assert.ok(bot.tg.chatMessages(OTHER_CHAT_ID).some(m => m.text.includes(String(OTHER_CHAT_ID))));
  assert.ok(bot.notices(/только администратор/).length === 1);
  assert.equal(bot.tg.chatMessages(ADMIN.id).filter(m => m.text.startsWith("PRIDE ONE | ЗАПИСЬ")).length, 0);
  await bot.init(ADMIN);
  assert.ok(bot.panelMessage());
}));

test("S3. Служебные эндпоинты без ADMIN_SECRET недоступны", withBot(async bot => {
  assert.equal((await bot.admin("GET", "/admin/status", null)).status, 401);
  assert.equal((await bot.admin("POST", "/admin/migrate", "wrong-secret-xxxxxxxx")).status, 401);
  // Защита webhook: с чужого домена (не *.workers.dev) он не переключается; GET остаётся диагностикой.
  assert.equal((await bot.admin("POST", "/admin/webhook")).status, 409);
  assert.equal(bot.tg.calls.filter(c => c.method === "setWebhook").length, 0);
  const diag = await bot.admin("GET", "/admin/webhook");
  assert.equal(diag.body.expected_url, null);
  assert.equal(diag.body.webhook.url_matches, null);
  bot.env.WEBHOOK_URL = "https://pride-one-bot.example.workers.dev/webhook";
  assert.equal((await bot.admin("POST", "/admin/webhook")).status, 200);
  assert.equal(bot.tg.calls.find(c => c.method === "setWebhook").p.url, bot.env.WEBHOOK_URL);
}));

test("S4. Ответ на чужую форму и просроченная форма не создают бронь", withBot(async bot => {
  await ready(bot);
  const prompt = await bot.openPrompt(U.A, TUE, "18:00");
  await bot.send(bot.replyUpdate(U.B, prompt, "Чужой"));
  assert.equal(bot.notices(/открыта другим родителем/).length, 1);
  bot.advance(21 * 60 * 1000);
  await bot.send(bot.replyUpdate(U.A, prompt, "Артём"));
  assert.equal(bot.notices(/Время ожидания истекло/).length, 1);
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM bookings")[0].c, 0);
}));

test("S5. Кнопки из другого чата и прошедшие слоты отклоняются", withBot(async bot => {
  await ready(bot);
  await bot.press(U.A, `book|P03|${TUE}|18:00`, { message_id: 5, chat: { id: OTHER_CHAT_ID, type: "supergroup" }, text: "x" });
  assert.match(bot.lastAnswer(), /недоступна в этом чате/);
  bot.clock.now = Date.parse(`${TUE}T18:30:00+03:00`);
  await bot.press(U.A, `book|P03|${TUE}|18:00`);
  assert.match(bot.lastAnswer(), /прошло или недоступно/);
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM pending_prompts")[0].c, 0);
}));

test("S6. Потерян ответ на отправку формы — родитель отвечает на форму, бронь создаётся по номеру формы", withBot(async bot => {
  await ready(bot);
  bot.tg.failNext("sendMessage", "lost", { when: p => /Форма №/.test(p.text || "") });
  await bot.press(U.A, `book|P03|${TUE}|18:00`);
  const prompt = bot.promptFor(U.A);
  assert.ok(prompt, "форма в чате есть");
  assert.equal(bot.sql("SELECT prompt_message_id FROM pending_prompts")[0].prompt_message_id, null);
  await bot.send(bot.replyUpdate(U.A, prompt, "Артём"));
  assert.equal(bot.activeCount(TUE, "18:00"), 1);
}));
