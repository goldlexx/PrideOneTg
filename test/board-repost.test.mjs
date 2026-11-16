/**
 * Общая панель — единственное информационное сообщение группы. При реальном изменении содержимого
 * публикуется НОВАЯ панель (внизу, с кнопкой), закрепляется; прежняя открепляется и удаляется.
 * Плюс: отмена без уведомления в группу и снятие прежних сообщений «список дня». Тесты B1–B22.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Bot, U, CHAT_ID, GROUP, TUE, BOARD_HEADER, PANEL_HEADER } from "./harness.mjs";

/** Запись через форму бота без кнопки в панели (в панели кнопок записи нет): старый callback book|… жив. */
async function bookDirect(bot, user, date, time, name) {
  await bot.press(user, `book|P03|${date}|${time}`, { message_id: 1, chat: GROUP, text: "x" });
  const prompt = bot.promptFor(user);
  if (!prompt) throw new Error("форма не отправлена: " + bot.lastAnswer());
  return bot.send(bot.replyUpdate(user, prompt, name));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const withBot = fn => async () => {
  const bot = new Bot();
  try { await fn(bot); } finally { await sleep(60); bot.close(); }
};

const cancelData = c => c.reply_markup.inline_keyboard[0][0].callback_data;
const key = id => `${CHAT_ID}:${id}`;
const panelRow = bot => bot.sql("SELECT * FROM telegram_messages WHERE kind = 'panel' AND ref = ''")[0];
const panelText = bot => bot.panelMessage().text;
const panelsInChat = bot => bot.tg.chatMessages(CHAT_ID).filter(m => (m.text || "").startsWith(PANEL_HEADER));
const dayBoards = bot => bot.tg.chatMessages(CHAT_ID).filter(m => (m.text || "").startsWith(BOARD_HEADER));
const sendsOf = (bot, prefix) => bot.tg.calls.filter(c => c.method === "sendMessage" && (c.p.text || "").startsWith(prefix));
const callsOf = (bot, method) => bot.tg.calls.filter(c => c.method === method);
const cancelNoticeSends = bot => bot.tg.calls.filter(c => c.method === "sendMessage" && /^Запись отменена\nРебёнок/.test(c.p.text || ""));
const isPanel = p => String(p.text || "").startsWith(PANEL_HEADER);
const MOVED = "Записи теперь показаны в общем сообщении с расписанием.";
const retireRow = bot => bot.sql("SELECT * FROM outbox WHERE event_type = 'board_retire' ORDER BY id DESC")[0];
const pinnedIds = bot => [...bot.tg.pinned].map(k => Number(k.split(":")[1]));

function seedLegacyBoard(bot, id = 7001, text = `${BOARD_HEADER}\nФилиал: Пролетарская\nВторник, 10 ноября\n\n18:00 — 1 ребёнок\n• Старое имя\n`) {
  bot.tg.seedMessage(CHAT_ID, id, text);
  bot.sql(`INSERT INTO telegram_messages (kind, ref, chat_id, message_id, page, rendered_hash, updated_at) VALUES ('day_board', ?, ?, ?, 0, '', 0)`,
    TUE, String(CHAT_ID), id);
  return id;
}
const legacyRows = bot => bot.sql("SELECT * FROM telegram_messages WHERE kind = 'day_board'");

/* ---------------------------- публикация и закрепление --------------------------- */

test("B1. Изменение записей: новая панель внизу с кнопкой, закреплена; прежняя откреплена и удалена; одна панель", withBot(async bot => {
  await bot.init();
  await bot.settle();
  const first = panelRow(bot).message_id;
  assert.deepEqual(pinnedIds(bot), [first], "панель, опубликованная /init, закреплена");

  await bot.book(U.A, TUE, "18:00", "Артём");
  await bot.settle();
  const second = panelRow(bot).message_id;

  assert.notEqual(second, first, "опубликовано новое сообщение");
  assert.ok(!bot.tg.messages.has(key(first)), "прежняя панель удалена");
  assert.equal(callsOf(bot, "unpinChatMessage").filter(c => c.p.message_id === first).length, 1, "прежняя откреплена");
  assert.deepEqual(pinnedIds(bot), [second], "закреплена только новая панель");
  assert.equal(panelsInChat(bot).length, 1);
  assert.equal(second, Math.max(...bot.tg.chatMessages(CHAT_ID).map(m => m.message_id)), "новая панель — самое нижнее сообщение");
  assert.equal(callsOf(bot, "pinChatMessage").at(-1).p.disable_notification, true, "закрепление без уведомления");

  const markup = bot.panelMessage().reply_markup;
  assert.equal(markup.inline_keyboard.length, 1);
  assert.match(markup.inline_keyboard[0][0].text, /Открыть приложение PRIDE ONE/);
  assert.match(markup.inline_keyboard[0][0].url, /^https:\/\/t\.me\/.+\?startapp$/);
  assert.match(panelText(bot), /Вторник, 10 ноября\n\n18:00\n• Артём$/);
  assert.doesNotMatch(panelText(bot), /19:00|детей|Пока никто/, "пустые занятия и счётчики не показываются");
  assert.equal(dayBoards(bot).length, 0, "отдельный список дня не публикуется");
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM outbox WHERE event_type = 'board_sync'")[0].c, 0);
}));

test("B2. Отмена одной записи из двух: без уведомления в группе, новая панель с оставшимся ребёнком", withBot(async bot => {
  await bot.init();
  await bot.book(U.B, TUE, "18:00", "Максим");
  const { confirmation } = await bot.book(U.A, TUE, "18:00", "Артём");
  await bot.settle();
  const before = panelRow(bot).message_id;

  await bot.press(U.A, cancelData(structuredClone(confirmation)), structuredClone(confirmation));
  await bot.settle();

  assert.equal(cancelNoticeSends(bot).length, 0);
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM outbox WHERE event_type = 'cancel_notice'")[0].c, 0);
  assert.notEqual(panelRow(bot).message_id, before);
  assert.match(panelText(bot), /18:00\n• Максим$/);
  assert.doesNotMatch(panelText(bot), /Артём/);
  assert.equal(panelsInChat(bot).length, 1);
  assert.deepEqual(pinnedIds(bot), [panelRow(bot).message_id]);
  assert.equal(bot.activeCount(TUE, "18:00"), 1);
}));

test("B3. Отмена последней записи: занятие исчезает из панели, остаётся «Пока никто не записан.»", withBot(async bot => {
  await bot.init();
  const { confirmation } = await bot.book(U.A, TUE, "18:00", "Артём");
  await bot.press(U.A, cancelData(structuredClone(confirmation)), structuredClone(confirmation));
  await bot.settle();
  assert.match(panelText(bot), /Пока никто не записан\./);
  assert.doesNotMatch(panelText(bot), /18:00/);
  assert.equal(panelsInChat(bot).length, 1);
}));

test("B4. Одинаковое содержимое не вызывает публикации: повторный drain, лишний panel_sync, часовой tick", withBot(async bot => {
  await bot.init();
  await bot.book(U.A, TUE, "18:00", "Артём");
  await bot.settle();
  const calls = bot.tg.calls.length;
  await bot.admin("POST", "/admin/drain?branch=P03");
  bot.sql(`INSERT INTO outbox (event_type, dedupe_key, payload, priority, status, attempts, next_attempt_at, created_at, updated_at)
           VALUES ('panel_sync', NULL, '{}', 2, 'pending', 0, 0, 0, 0)`);
  await bot.admin("POST", "/admin/drain?branch=P03");
  await bot.ns.fireTick?.("P03");
  assert.equal(bot.tg.calls.length, calls, "содержимое то же — ни отправок, ни закреплений, ни удалений");
}));

/* ------------------------------ сбои: отправка, закрепление ------------------------------ */

test("B5. Не удалось отправить новую панель: прежняя закреплённая остаётся, после повтора — одна новая", withBot(async bot => {
  await bot.init();
  await bot.settle();
  const old = panelRow(bot).message_id;
  bot.tg.failNext("sendMessage", { code: 502, description: "Bad Gateway" }, { when: isPanel, times: 2 });
  await bot.book(U.B, TUE, "18:00", "Максим");

  assert.ok(bot.tg.messages.has(key(old)), "прежняя панель не удалена");
  assert.deepEqual(pinnedIds(bot), [old], "и остаётся закреплённой");
  assert.equal(callsOf(bot, "deleteMessage").filter(c => c.p.message_id === old).length, 0);
  assert.equal(callsOf(bot, "unpinChatMessage").length, 0);

  await bot.advanceAndSettle(2100);
  await bot.advanceAndSettle(4100);
  assert.equal(panelsInChat(bot).length, 1);
  assert.match(panelText(bot), /• Максим/);
  assert.deepEqual(pinnedIds(bot), [panelRow(bot).message_id]);
  assert.ok(!bot.tg.messages.has(key(old)));
}));

test("B6. Закрепление не удалось (нет права): прежняя закреплённая панель не удалена, новая убрана, причина видна; дальше правка на месте", withBot(async bot => {
  await bot.init();
  await bot.settle();
  const old = panelRow(bot).message_id;
  bot.tg.failNext("pinChatMessage", { code: 400, description: "Bad Request: not enough rights to pin a message" }, { times: 99 });
  await bot.book(U.A, TUE, "18:00", "Артём");
  await bot.settle();

  assert.equal(panelRow(bot).message_id, old, "текущей снова стала прежняя закреплённая панель");
  assert.ok(bot.tg.messages.has(key(old)), "она не удалена");
  assert.deepEqual(pinnedIds(bot), [old], "и закреплена");
  assert.equal(panelsInChat(bot).length, 1, "незакреплённая новая убрана — панель одна");
  assert.match(panelText(bot), /18:00\n• Артём$/, "содержимое обновлено правкой на месте");
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM outbox WHERE status = 'failed'")[0].c, 0);

  const status = (await bot.admin("GET", "/admin/status?branch=P03")).body.status;
  assert.equal(status.panel_pin.blocked, true);
  assert.match(status.panel_pin.problem.error, /not enough rights/);
  assert.equal(bot.notices(/Не удалось закрепить панель/).length, 1, "группа получила одно сообщение о проблеме");

  await bot.book(U.B, TUE, "18:00", "Максим");                 // права не обходим: панель правится на месте
  await bot.settle();
  assert.equal(panelRow(bot).message_id, old);
  assert.match(panelText(bot), /18:00\n• Артём\n• Максим$/);
  assert.equal(callsOf(bot, "deleteMessage").filter(c => c.p.message_id === old).length, 0);
  assert.equal(bot.notices(/Не удалось закрепить панель/).length, 1, "сообщение о проблеме не повторяется");

  bot.tg.rules.length = 0;                                       // право выдано → /init возвращает закрепление
  await bot.init();
  await bot.settle();
  assert.equal((await bot.admin("GET", "/admin/status?branch=P03")).body.status.panel_pin.blocked, false);
  await bot.book(U.C, TUE, "19:00", "София");
  await bot.settle();
  assert.deepEqual(pinnedIds(bot), [panelRow(bot).message_id]);
  assert.notEqual(panelRow(bot).message_id, old, "снова публикуется новая панель");
  assert.equal(panelsInChat(bot).length, 1);
}));

test("B7. Временная ошибка закрепления (502): старая панель не удаляется до успешного закрепления", withBot(async bot => {
  await bot.init();
  await bot.settle();
  const old = panelRow(bot).message_id;
  bot.tg.failNext("pinChatMessage", { code: 502, description: "Bad Gateway" }, { times: 2 });
  await bot.book(U.A, TUE, "18:00", "Артём");
  assert.ok(bot.tg.messages.has(key(old)), "прежняя панель ещё на месте");
  assert.equal(callsOf(bot, "deleteMessage").filter(c => c.p.message_id === old).length, 0);

  await bot.advanceAndSettle(2100);
  await bot.advanceAndSettle(4100);
  assert.ok(!bot.tg.messages.has(key(old)), "после успешного закрепления прежняя удалена");
  assert.deepEqual(pinnedIds(bot), [panelRow(bot).message_id]);
  assert.equal(panelsInChat(bot).length, 1);
}));

test("B8. Ошибки открепления и удаления прежней панели: не теряют новую, повтор не бесконечен", withBot(async bot => {
  await bot.init();
  await bot.settle();
  const old = panelRow(bot).message_id;
  bot.tg.failNext("unpinChatMessage", { code: 400, description: "Bad Request: not enough rights to unpin" }, { times: 9 });
  bot.tg.failNext("deleteMessage", { code: 400, description: "Bad Request: message can't be deleted for everyone" }, { when: p => p.message_id === old, times: 9 });
  await bot.book(U.A, TUE, "18:00", "Артём");
  await bot.settle();

  assert.equal(bot.tg.messages.get(key(old)).text, "Актуальная панель записи — в закреплённом сообщении ниже.", "имена в старой панели не остались");
  assert.match(panelText(bot), /• Артём/);
  assert.equal(panelsInChat(bot).length, 1);
  assert.equal(bot.sql("SELECT status FROM outbox WHERE event_type = 'panel_retire'")[0].status, "done");
  assert.equal(callsOf(bot, "deleteMessage").filter(c => c.p.message_id === old).length, 1, "без повторов");
}));

test("B9. Панель удалили вручную: изменение публикует одну новую закреплённую, ошибки нет", withBot(async bot => {
  await bot.init();
  await bot.settle();
  bot.tg.messages.delete(key(panelRow(bot).message_id));
  await bookDirect(bot, U.B, TUE, "18:00", "Максим");
  await bot.settle();
  assert.equal(panelsInChat(bot).length, 1);
  assert.match(panelText(bot), /• Максим/);
  assert.deepEqual(pinnedIds(bot), [panelRow(bot).message_id]);
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM outbox WHERE status = 'failed'")[0].c, 0);
}));

test("B10. Панель удалена сразу после отправки (закрепить нечего): публикуется заново, одна панель", withBot(async bot => {
  await bot.init();
  await bot.settle();
  bot.tg.failNext("pinChatMessage", { code: 400, description: "Bad Request: message to pin not found" });
  await bot.book(U.A, TUE, "18:00", "Артём");
  await bot.settle();
  assert.equal(panelsInChat(bot).length, 1);
  assert.deepEqual(pinnedIds(bot), [panelRow(bot).message_id]);
  assert.equal((await bot.admin("GET", "/admin/status?branch=P03")).body.status.panel_pin.blocked, false, "это не нехватка прав");
}));

/* --------------------------- параллельность и повторы --------------------------- */

test("B11. Параллельные записи: одна закреплённая актуальная панель, прежние удалены", withBot(async bot => {
  await bot.init();
  const parents = Array.from({ length: 6 }, (_, i) => ({ id: 3000 + i, first_name: `П${i}`, is_bot: false }));
  for (const p of parents) await bot.openPrompt(p, TUE, "19:00");
  await Promise.all(parents.map((p, i) => bot.send(bot.replyUpdate(p, bot.promptFor(p), `Ребёнок${i}`))));
  await bot.settle();
  assert.equal(panelsInChat(bot).length, 1);
  assert.equal(bot.panelCount(TUE, "19:00"), 6);
  for (let i = 0; i < 6; i++) assert.match(panelText(bot), new RegExp(`• Ребёнок${i}`));
  assert.deepEqual(pinnedIds(bot), [panelRow(bot).message_id]);
  assert.ok(sendsOf(bot, PANEL_HEADER).length <= 8, "публикации не размножаются");
}));

test("B12. Запись и отмена почти одновременно: в закреплённой панели итоговое состояние", withBot(async bot => {
  await bot.init();
  const { confirmation } = await bot.book(U.A, TUE, "18:00", "Артём");
  await bot.openPrompt(U.B, TUE, "18:00");
  await Promise.all([
    bot.send(bot.replyUpdate(U.B, bot.promptFor(U.B), "Максим")),
    bot.press(U.A, cancelData(structuredClone(confirmation)), structuredClone(confirmation))
  ]);
  await bot.settle();
  assert.match(panelText(bot), /18:00\n• Максим$/);
  assert.doesNotMatch(panelText(bot), /Артём/);
  assert.equal(panelsInChat(bot).length, 1);
  assert.deepEqual(pinnedIds(bot), [panelRow(bot).message_id]);
}));

test("B13. Устаревшие и повторные задачи закрепления/снятия безвредны", withBot(async bot => {
  await bot.init();
  await bot.book(U.A, TUE, "18:00", "Артём");
  await bot.settle();
  const current = panelRow(bot).message_id;
  const add = (type, payload) => bot.sql(`INSERT INTO outbox (event_type, dedupe_key, payload, priority, status, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, NULL, ?, 1, 'pending', 0, 0, 0, 0)`, type, JSON.stringify(payload));
  add("panel_retire", { chat_id: String(CHAT_ID), message_id: current });       // снять актуальную — нельзя
  add("panel_pin", { chat_id: String(CHAT_ID), message_id: current - 1 });      // закрепить устаревшую — нельзя
  await bot.admin("POST", "/admin/drain?branch=P03");
  assert.ok(bot.tg.messages.has(key(current)));
  assert.deepEqual(pinnedIds(bot), [current]);
  assert.equal(panelsInChat(bot).length, 1);
}));

test("B14. Потерянный ответ при публикации новой панели: возможна одна лишняя копия, прежняя известная удаляется, id верный", withBot(async bot => {
  await bot.init();
  await bot.settle();
  bot.tg.failNext("sendMessage", "lost", { when: isPanel });
  await bot.book(U.A, TUE, "18:00", "Артём");
  await bot.advanceAndSettle(2100);
  await bot.advanceAndSettle(4100);
  assert.ok(panelsInChat(bot).length <= 2, "ограничение API: максимум одна лишняя копия");
  assert.equal(panelRow(bot).message_id, panelsInChat(bot).at(-1).message_id, "в базе самая нижняя");
  assert.deepEqual(pinnedIds(bot), [panelRow(bot).message_id]);
  await bot.book(U.B, TUE, "18:00", "Максим");
  await bot.settle();
  assert.ok(panelsInChat(bot).length <= 2, "дальше копии не накапливаются");
}));

test("B15. Ошибка SQL между сохранением id новой панели и постановкой закрепления: откат обеих операций", withBot(async bot => {
  await bot.init();
  await bot.settle();
  const old = panelRow(bot).message_id;
  const fault = { match: /INSERT OR IGNORE INTO outbox/, remaining: 1, when: (_q, params) => params[0] === "panel_pin" };
  bot.ns.faults.push(fault);
  await bot.book(U.A, TUE, "18:00", "Артём");
  assert.equal(fault.remaining, 0);
  assert.equal(panelRow(bot).message_id, old, "новый id не сохранён без задачи закрепления");
  assert.ok(bot.tg.messages.has(key(old)), "прежняя панель не удалена");
  await bot.advanceAndSettle(2100);
  await bot.advanceAndSettle(4100);
  assert.deepEqual(pinnedIds(bot), [panelRow(bot).message_id]);
  assert.ok(!bot.tg.messages.has(key(old)));
  assert.ok(panelsInChat(bot).length <= 2, "максимум одна осиротевшая копия от сбоя");
}));

test("B16. Служебное сообщение «бот закрепил сообщение» удаляется", withBot(async bot => {
  await bot.init();
  await bot.settle();
  bot.tg.seedMessage(CHAT_ID, 9100, "PrideOne закрепил(а) сообщение");
  await bot.send({ message: { message_id: 9100, date: 0, chat: GROUP, from: { id: 777, is_bot: true, first_name: "PrideOneBookingBot" }, pinned_message: { message_id: 5000 } } });
  await bot.settle();
  assert.ok(!bot.tg.messages.has(key(9100)));
}));

/* ------------------------------- мусор, длина, окно ------------------------------- */

test("B17. Длинная панель не превышает лимит Telegram (4096)", withBot(async bot => {
  await bot.init();
  for (let i = 0; i < 120; i++) {
    bot.sql(
      `INSERT INTO bookings (id, branch_id, date, time, child_name, normalized_child_name, parent_id, parent_name, status, source, created_at)
       VALUES (?, 'P03', ?, '18:00', ?, ?, '1', 'П', 'active', 'bot', ?)`,
      `x${i}`, TUE, `Очень длинное имя ребёнка номер ${i} ${"я".repeat(30)}`, `n${i}`, i
    );
  }
  await bot.book(U.A, TUE, "19:00", "Артём");
  await bot.settle();
  assert.ok(panelText(bot).length <= 4096, `длина ${panelText(bot).length}`);
  assert.match(panelText(bot), /18:00\n• Очень длинное имя/);
  assert.match(panelText(bot), /… и ещё \d+/, "остаток обозначен");
  assert.equal(panelsInChat(bot).length, 1);
}));

test("B18. Третья ближайшая дата доступна и видна в панели; четвёртая — нет (подробно в three-dates.test.mjs)", withBot(async bot => {
  await bot.init();
  await bookDirect(bot, U.A, "2026-11-15", "12:00", "Лена");     // вс — третья дата (вт 10, чт 12, вс 15)
  await bot.settle();
  assert.match(panelText(bot), /Воскресенье, 15 ноября\n\n12:00\n• Лена/);
  await bot.press(U.B, "book|P03|2026-11-17|18:00", { message_id: 1, chat: GROUP, text: "x" });   // четвёртая дата
  assert.match(bot.lastAnswer(), /недоступно/);
  assert.equal(bot.promptFor(U.B), null, "форма для четвёртой даты не открывается");
}));

test("B19. Прежний «список дня» снимается после публикации панели: сначала новая панель, затем удаление", withBot(async bot => {
  await bot.init();
  const id = seedLegacyBoard(bot);
  await bot.book(U.A, TUE, "18:00", "Артём");
  await bot.settle();
  assert.ok(!bot.tg.messages.has(key(id)));
  assert.equal(dayBoards(bot).length, 0);
  assert.equal(legacyRows(bot).length, 0);
  const panelSend = bot.tg.calls.findIndex(c => c.method === "sendMessage" && String(c.p.text).includes("• Артём"));
  const del = bot.tg.calls.findIndex(c => c.method === "deleteMessage" && c.p.message_id === id);
  assert.ok(panelSend >= 0 && del > panelSend);
}));

test("B20. Прежний список дня: нельзя удалить — текст заменён; уже удалён — без правок; не правится — failed без повторов", withBot(async bot => {
  await bot.init();
  const cant = seedLegacyBoard(bot, 7001);
  bot.tg.failNext("deleteMessage", { code: 400, description: "Bad Request: message can't be deleted for everyone" }, { when: p => p.message_id === cant, times: 5 });
  await bot.book(U.A, TUE, "18:00", "Артём");
  await bot.settle();
  assert.equal(bot.tg.messages.get(key(cant)).text, MOVED);

  const gone = seedLegacyBoard(bot, 7002);
  bot.tg.messages.delete(key(gone));
  await bot.book(U.B, TUE, "18:00", "Максим");
  await bot.settle();
  assert.equal(callsOf(bot, "editMessageText").filter(c => c.p.message_id === gone).length, 0);

  const stuck = seedLegacyBoard(bot, 7003);
  bot.tg.failNext("deleteMessage", { code: 403, description: "Forbidden: not enough rights" }, { when: p => p.message_id === stuck, times: 5 });
  bot.tg.failNext("editMessageText", { code: 403, description: "Forbidden: bot was kicked" }, { when: p => p.message_id === stuck, times: 5 });
  await bot.book(U.C, TUE, "19:00", "Вера");
  await bot.settle();
  await bot.advanceAndSettle(30 * 60 * 1000);
  const row = retireRow(bot);
  assert.equal(row.status, "failed");
  assert.match(row.last_error, /editMessageText.*403/);
  assert.equal(row.attempts, 1);
}));

test("B21. Ошибка SQL при снятии прежнего списка дня: откат целиком, после повтора снят", withBot(async bot => {
  await bot.init();
  const id = seedLegacyBoard(bot);
  const fault = { match: /INSERT OR IGNORE INTO outbox/, remaining: 1, when: (_q, params) => params[0] === "board_retire" };
  bot.ns.faults.push(fault);
  await bot.book(U.A, TUE, "18:00", "Артём");
  assert.equal(fault.remaining, 0);
  assert.equal(legacyRows(bot).length, 1);
  assert.ok(bot.tg.messages.has(key(id)));
  await bot.advanceAndSettle(2100);
  await bot.advanceAndSettle(4100);
  assert.equal(legacyRows(bot).length, 0);
  assert.ok(!bot.tg.messages.has(key(id)));
}));

test("B22. /help про Mini App; старые board_sync и cancel_notice из очереди закрываются без публикаций", withBot(async bot => {
  await bot.init();
  await bot.send(bot.message(U.A, "/help"));
  await bot.settle();
  const help = bot.notices(/PRIDE ONE — запись/).at(-1).text;
  assert.match(help, /Открыть приложение PRIDE ONE/);
  assert.doesNotMatch(help, /кнопку с датой и временем|Reply/);

  const { confirmation } = await bot.book(U.A, TUE, "18:00", "Артём");
  await bot.press(U.A, cancelData(structuredClone(confirmation)), structuredClone(confirmation));
  const bid = bot.sql("SELECT id FROM bookings")[0].id;
  const add = (type, payload) => bot.sql(`INSERT INTO outbox (event_type, dedupe_key, payload, priority, status, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, NULL, ?, 0, 'pending', 0, 0, 0, 0)`, type, JSON.stringify(payload));
  add("cancel_notice", { booking_id: bid });
  add("board_sync", { date: TUE });
  await bot.admin("POST", "/admin/drain?branch=P03");
  await bot.settle();
  assert.equal(cancelNoticeSends(bot).length, 0);
  assert.equal(sendsOf(bot, BOARD_HEADER).length, 0);
  assert.equal(bot.sql("SELECT COUNT(*) AS c FROM outbox WHERE status IN ('pending','sending')")[0].c, 0);
}));
