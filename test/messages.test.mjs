/**
 * R. Идемпотентность публикации: /init, панель, общее сообщение дня.
 * Цель — убедиться, что повторы outbox не создают необоснованных дублей сообщений.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Bot, U, ADMIN, CHAT_ID, TUE, BOARD_HEADER, PANEL_HEADER } from "./harness.mjs";

const withBot = fn => async () => {
  const bot = new Bot();
  try { await fn(bot); } finally { bot.close(); }
};

// Панель — сообщение, начинающееся с "PRIDE ONE | ЗАПИСЬ\n" (у общего списка дня после «ЗАПИСЬ» идёт пробел).
const panels = bot => bot.tg.chatMessages(CHAT_ID).filter(m => (m.text || "").startsWith(PANEL_HEADER));
const panelRow = bot => bot.sql("SELECT * FROM telegram_messages WHERE kind = 'panel' AND ref = ''")[0];
const sends = (bot, prefix) => bot.tg.calls.filter(c => c.method === "sendMessage" && (c.p.text || "").startsWith(prefix));

test("R1. Два последовательных /init — одна панель, второй /init редактирует первую", withBot(async bot => {
  await bot.init();
  const first = panels(bot);
  assert.equal(first.length, 1);
  await bot.init();
  assert.equal(panels(bot).length, 1, "вторая панель не появилась");
  assert.equal(panels(bot)[0].message_id, first[0].message_id);
  assert.equal(panelRow(bot).message_id, first[0].message_id);
  assert.equal(sends(bot, PANEL_HEADER).length, 1, "sendMessage для панели вызван один раз");
}));

test("R2. Три /init одновременно — одна панель", withBot(async bot => {
  await Promise.all([bot.init(), bot.init(), bot.init()]);
  await bot.settle();
  assert.equal(panels(bot).length, 1);
  assert.equal(sends(bot, PANEL_HEADER).length, 1);
}));

test("R3. Панель удалена вручную — /init публикует ровно одну новую, следующий /init её редактирует", withBot(async bot => {
  await bot.init();
  const old = panels(bot)[0];
  bot.tg.messages.delete(`${CHAT_ID}:${old.message_id}`);
  await bot.init();
  assert.equal(panels(bot).length, 1);
  const fresh = panels(bot)[0];
  assert.notEqual(fresh.message_id, old.message_id);
  assert.equal(panelRow(bot).message_id, fresh.message_id);
  await bot.init();
  assert.equal(panels(bot).length, 1);
  assert.equal(panels(bot)[0].message_id, fresh.message_id);
}));

test("R4. Панель удалена — запись восстанавливает одну панель, следующие записи её редактируют", withBot(async bot => {
  await bot.init();
  const old = panels(bot)[0];
  bot.tg.messages.delete(`${CHAT_ID}:${old.message_id}`);
  // Кнопка из удалённой панели ещё видна у родителя в клиенте Telegram.
  await bot.press(U.A, `book|P03|${TUE}|18:00`, old);
  const prompt = bot.promptFor(U.A);
  await bot.send(bot.replyUpdate(U.A, prompt, "Артём"));
  await bot.settle();
  assert.equal(panels(bot).length, 1, "панель восстановлена одна");
  assert.equal(bot.panelCount(TUE, "18:00"), 1);
  await bot.book(U.B, TUE, "18:00", "Максим");
  await bot.book(U.C, TUE, "19:00", "София");
  assert.equal(panels(bot).length, 1, "каждое изменение публикует новую панель и убирает прежнюю");
  assert.equal(bot.panelCount(TUE, "18:00"), 2);
}));

test("R5. Telegram 502 при публикации панели — повторы, в итоге одна панель", withBot(async bot => {
  bot.tg.failNext("sendMessage", { code: 502, description: "Bad Gateway" },
    { when: p => (p.text || "").startsWith(PANEL_HEADER), times: 2 });
  await bot.init();
  assert.equal(panels(bot).length, 0);
  await bot.advanceAndSettle(2100);
  assert.equal(panels(bot).length, 0);
  await bot.advanceAndSettle(4100);
  assert.equal(panels(bot).length, 1);
  assert.equal(bot.outbox("pending").length, 0);
}));

test("R6. Сетевая ошибка при правке существующей панели (/init) — повторяется правка, новой панели нет", withBot(async bot => {
  await bot.init();
  const id = panels(bot)[0].message_id;
  bot.tg.failNext("editMessageText", "network", { when: p => p.message_id === id, times: 2 });
  await bot.init();
  await bot.advanceAndSettle(2100);
  await bot.advanceAndSettle(4100);
  assert.equal(panels(bot).length, 1);
  assert.equal(panels(bot)[0].message_id, id);
  assert.match(panels(bot)[0].text, /PRIDE ONE · Пролетарская/);
  assert.equal(sends(bot, PANEL_HEADER).length, 1);
}));

test("R7. Панель: 502 и сетевые ошибки при публикации — прежняя остаётся, затем ровно одна актуальная", withBot(async bot => {
  await bot.init();
  const first = panels(bot)[0].message_id;
  bot.tg.failNext("sendMessage", { code: 502, description: "Bad Gateway" },
    { when: p => (p.text || "").startsWith(PANEL_HEADER), times: 1 });
  await bot.book(U.A, TUE, "18:00", "Артём");
  assert.equal(panels(bot)[0].message_id, first, "пока новая не отправлена, прежняя панель на месте");
  assert.doesNotMatch(bot.board(TUE), /Артём/);
  await bot.advanceAndSettle(2100);
  assert.match(bot.board(TUE), /• Артём/);

  bot.tg.failNext("sendMessage", "network", { when: p => (p.text || "").startsWith(PANEL_HEADER), times: 2 });
  await bot.book(U.B, TUE, "18:00", "Максим");
  await bot.advanceAndSettle(2100);
  await bot.advanceAndSettle(4100);
  assert.equal(bot.boards(TUE).length, 1);
  assert.match(bot.board(TUE), /18:00\n• Артём\n• Максим\n/);
  assert.equal(sends(bot, BOARD_HEADER).length, 0, "списки дня не публикуются");
}));

test("R8. Много записей подряд в один день — панель одна, задачи схлопываются", withBot(async bot => {
  await bot.init();
  const parents = Array.from({ length: 6 }, (_, i) => ({ id: 2000 + i, first_name: `П${i}`, is_bot: false }));
  for (const p of parents) await bot.openPrompt(p, TUE, "19:00");
  await Promise.all(parents.map((p, i) => bot.send(bot.replyUpdate(p, bot.promptFor(p), `Ребёнок${i}`))));
  await bot.settle();
  assert.equal(bot.boards(TUE).length, 1);
  assert.equal(sends(bot, BOARD_HEADER).length, 0);
  assert.equal(panels(bot).length, 1);
  assert.equal(bot.panelCount(TUE, "19:00"), 6);
}));

test("R9. Перезапуск объекта во время публикации панели (зависший запрос) — после аренды одна панель", withBot(async bot => {
  bot.tg.failNext("sendMessage", "hang", { when: p => (p.text || "").startsWith(PANEL_HEADER) });
  await bot.send(bot.message(ADMIN, "/init P03"), { background: "drop" });
  await new Promise(r => setTimeout(r, 50));
  bot.ns.restart("P03");
  await bot.advanceAndSettle(61_000);
  assert.equal(panels(bot).length, 1);
  await bot.init();
  assert.equal(panels(bot).length, 1);
}));

test("R10. Потерянный ответ при создании панели — известное ограничение: максимум одна лишняя, дальше всё идёт в одну", withBot(async bot => {
  bot.tg.failNext("sendMessage", "lost", { when: p => (p.text || "").startsWith(PANEL_HEADER) });
  await bot.init();
  assert.equal(panels(bot).length, 1, "сообщение доставлено, но бот об этом не знает");
  await bot.advanceAndSettle(2100);
  assert.equal(panels(bot).length, 2, "повтор отправки: Telegram не даёт узнать, что первая попытка дошла");
  const tracked = panelRow(bot).message_id;
  await bot.init();
  await bot.book(U.A, TUE, "18:00", "Артём");
  assert.equal(panels(bot).length, 2, "третьей панели нет: отслеживаемая заменена новой, лишняя копия осталась");
  assert.notEqual(panelRow(bot).message_id, tracked, "актуальная панель — новая, прежняя отслеживаемая удалена");
  assert.equal(panels(bot).at(-1).message_id, panelRow(bot).message_id, "актуальная — самая нижняя");
}));
