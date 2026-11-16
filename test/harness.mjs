import worker from "../src/index.js";
import { BranchBookingDO, BOARD_HEADER, CONFIRM_HEADER, PANEL_HEADER, MY_LIST_HEADER, dateLabel } from "../src/branch-do.js";
import { rmSync } from "node:fs";
import { DONamespaceEmu, KVMock, TelegramMock } from "./emulator.mjs";

export const CHAT_ID = -1001234567890;
export const OTHER_CHAT_ID = -1009999999999;
export const BOT_ID = 777;
export const ADMIN = { id: 1, first_name: "Админ", is_bot: false };
export const U = {
  A: { id: 101, first_name: "Анна", is_bot: false },
  B: { id: 202, first_name: "Борис", is_bot: false },
  C: { id: 303, first_name: "Вера", is_bot: false },
  D: { id: 404, first_name: "Дина", is_bot: false }
};
export const GROUP = { id: CHAT_ID, type: "supergroup", title: "Pride Test" };
// Вторник, 10 ноября 2026, 09:00 МСК: занятия этого дня в 18:00 и 19:00 ещё впереди.
export const START_NOW = Date.parse("2026-11-10T09:00:00+03:00");
export const TUE = "2026-11-10";
export const THU = "2026-11-12";
export const SUN = "2026-11-15";

export class Bot {
  /** opts.DOClass — класс Durable Object (по умолчанию текущий из src/); нужен тестам обновления. */
  constructor(opts = {}) {
    this.clock = { now: START_NOW };
    this.tg = new TelegramMock({ botId: BOT_ID, admins: [ADMIN.id] });
    this.kv = new KVMock();
    this.env = {
      BOT_TOKEN: `${BOT_ID}:TEST-TOKEN`,
      WEBHOOK_SECRET: "webhook-secret",
      ADMIN_SECRET: "admin-secret-0123456789",
      BRANCH_CHATS: JSON.stringify({ P03: String(CHAT_ID) }),
      PRIDE_KV: this.kv,
      TEST_NOW: () => this.clock.now
    };
    this.ns = new DONamespaceEmu(opts.DOClass || BranchBookingDO, this.env, this.clock);
    this.env.BRANCH_DO = this.ns;
    this.updateId = 1;
    this.msgId = 1;
  }

  close() {
    this.tg.restore();
    this.ns.cleanup();
  }

  advance(ms) { this.clock.now += ms; }

  /**
   * «Развёртывание» другой версии кода Durable Object над теми же данными: файлы SQLite и будильник
   * сохраняются, память экземпляров теряется (как при обновлении кода в Cloudflare).
   */
  deployDO(Cls) {
    const old = this.ns;
    const next = new DONamespaceEmu(Cls, this.env, this.clock);
    rmSync(next.dir, { recursive: true, force: true });
    next.dir = old.dir;
    next.alarms = old.alarms;
    next.faults = old.faults;
    for (const obj of old.objects.values()) { try { obj.db.close(); } catch (_) {} }
    old.objects.clear();
    this.env.BRANCH_DO = next;
    this.ns = next;
  }

  sql(q, ...p) { return this.ns.query("P03", q, ...p); }

  /** Отправляет update в Worker. background: 'await' — дождаться drain; 'drop' — Worker «умер» после ответа. */
  async send(update, { background = "await", secret = this.env.WEBHOOK_SECRET } = {}) {
    if (update.update_id === undefined) update.update_id = this.updateId++;
    const pending = [];
    const ctx = { waitUntil: p => pending.push(p), passThroughOnException() {} };
    const res = await worker.fetch(new Request("https://bot.test/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
      body: JSON.stringify(update)
    }), this.env, ctx);
    if (background === "await") await Promise.all(pending);
    const body = await res.json().catch(() => null);
    return { status: res.status, body, update };
  }

  async admin(method, pathAndQuery, token = this.env.ADMIN_SECRET) {
    const pending = [];
    const res = await worker.fetch(new Request(`https://bot.test${pathAndQuery}`, {
      method, headers: token ? { Authorization: `Bearer ${token}` } : {}
    }), this.env, { waitUntil: p => pending.push(p) });
    await Promise.all(pending);
    return { status: res.status, body: await res.json() };
  }

  /** Срабатывание будильников, пока есть что делать (время не двигается). */
  async settle() {
    for (let i = 0; i < 20; i++) {
      if (!(await this.ns.fireDueAlarms())) break;
    }
  }

  async advanceAndSettle(ms) {
    this.advance(ms);
    await this.settle();
  }

  message(from, text, extra = {}) {
    return { message: { message_id: this.msgId++, date: 0, chat: GROUP, from, text, ...extra } };
  }

  callback(from, data, message) {
    return {
      callback_query: {
        id: `cb${this.updateId}-${Math.random()}`,
        from,
        data,
        chat_instance: "x",
        message: { message_id: message.message_id, chat: message.chat ?? GROUP, text: message.text, date: 0 }
      }
    };
  }

  async init(user = ADMIN) {
    return this.send(this.message(user, "/init@PrideOneBookingBot P03"));
  }

  panelMessage() {
    const row = this.sql("SELECT * FROM telegram_messages WHERE kind = 'panel' AND ref = ''")[0];
    return row ? this.tg.messages.get(`${row.chat_id}:${row.message_id}`) : null;
  }

  // Кнопок записи в панели больше нет (только URL Mini App): слот определяется по тексту панели,
  // а запись идёт через сохранённый в боте старый callback book|… (как в старых сообщениях).
  panelCount(date, time) {
    const old = this.panelMessage()?.reply_markup?.inline_keyboard?.flat()
      .find(b => b.callback_data === `book|P03|${date}|${time}`);
    if (old) return Number(old.text.match(/\((\d+)\)$/)[1]); // панель старой версии (архивные тесты)
    // Новый формат: дата, пустая строка, время, «• имя»…; пустые занятия не показываются (тогда 0).
    const lines = (this.panelMessage()?.text || "").split("\n");
    const d = lines.indexOf(dateLabel(date));
    if (d < 0) return 0;
    let count = 0;
    let inSlot = false;
    for (let i = d + 1; i < lines.length && !/^─+$/.test(lines[i]); i++) {
      if (/^\d\d:\d\d$/.test(lines[i])) inSlot = lines[i] === time;
      else if (inSlot && lines[i].startsWith("• ")) count++;
    }
    return count;
  }

  panelButton(date, time) {
    return { callback_data: `book|P03|${date}|${time}` };   // в панели кнопок записи нет: форму открывает старый callback
  }

  async press(user, data, message = this.panelMessage(), opts) {
    return this.send(this.callback(user, data, message), opts);
  }

  lastAnswer() { return this.tg.answers.at(-1)?.text || ""; }

  promptFor(user) {
    return this.tg.chatMessages(CHAT_ID).filter(m =>
      /Форма №\d+/.test(m.text || "") && m.entities?.some(e => e.user?.id === user.id)
    ).at(-1) || null;
  }

  replyUpdate(user, prompt, text) {
    return this.message(user, text, {
      reply_to_message: {
        message_id: prompt.message_id, chat: GROUP, date: prompt.date, text: prompt.text,
        entities: prompt.entities, from: { id: BOT_ID, is_bot: true, first_name: "PrideOneBookingBot" }
      }
    });
  }

  async openPrompt(user, date, time, opts) {
    if (!this.panelButton(date, time)) throw new Error(`Кнопки ${date} ${time} нет в панели`);
    await this.press(user, `book|P03|${date}|${time}`, this.panelMessage(), opts);
    return this.promptFor(user);
  }

  async book(user, date, time, name) {
    const prompt = await this.openPrompt(user, date, time);
    if (!prompt) throw new Error("форма записи не отправлена: " + this.lastAnswer());
    const res = await this.send(this.replyUpdate(user, prompt, name));
    return { res, confirmation: this.confirmations(name).at(-1) || null };
  }

  confirmations(name) {
    return this.tg.chatMessages(CHAT_ID).filter(m => (m.text || "").startsWith(CONFIRM_HEADER) && m.text.includes(`Ребёнок: ${name}\n`));
  }

  /** Информационные сообщения группы за дату. Теперь это только общая панель (списки дня больше не публикуются). */
  boards(date) {
    return this.tg.chatMessages(CHAT_ID).filter(m =>
      (m.text || "").startsWith(PANEL_HEADER) || (m.text || "").startsWith(BOARD_HEADER));   // date не фильтрует: пустые дни в панели не показываются
  }

  /** Самое нижнее сообщение дня (если по ограничению API в чате осталась лишняя копия). */
  board_last(date) { return this.boards(date).at(-1).text + "\n"; }

  board(date) {
    const all = this.boards(date);
    if (all.length !== 1) throw new Error(`Ожидалось одно общее сообщение дня ${date}, найдено ${all.length}`);
    return all[0].text + "\n";   // завершающий перевод строки упрощает проверки блоков
  }

  myLists() { return this.tg.chatMessages(CHAT_ID).filter(m => (m.text || "").startsWith(MY_LIST_HEADER)); }

  notices(re) { return this.tg.chatMessages(CHAT_ID).filter(m => re.test(m.text || "")); }

  activeCount(date, time) {
    return this.sql("SELECT COUNT(*) AS c FROM bookings WHERE date = ? AND time = ? AND status = 'active'", date, time)[0].c;
  }

  outbox(status) { return this.sql("SELECT * FROM outbox WHERE status = ? ORDER BY id", status); }
}

export { PANEL_HEADER, BOARD_HEADER, CONFIRM_HEADER, MY_LIST_HEADER };
