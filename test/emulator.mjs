/**
 * Эмулятор окружения Cloudflare для автотестов (Node.js 22+, без сети).
 *
 *  - SqlStorage поверх настоящего SQLite (node:sqlite, файл на диске);
 *  - transactionSync с BEGIN/COMMIT/ROLLBACK; прямой BEGIN через exec запрещён, как в Cloudflare;
 *  - будильник (alarm), сохраняемый между «перезапусками» объекта;
 *  - перезапуск объекта: новый экземпляр класса над тем же файлом БД, память теряется;
 *  - RPC-заглушка со случайной задержкой и структурным клонированием аргументов;
 *  - внедрение ошибок SQL по шаблону запроса;
 *  - KV с list/get/put;
 *  - мок Telegram Bot API с внедрением сбоев: network, HTTP 5xx, 429, 400, «зависание»,
 *    «потерянный ответ» (сообщение доставлено, но вызывающий получил ошибку).
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const clone = v => (v === undefined ? v : structuredClone(v));

class SqlStorageEmu {
  constructor(db, faults) {
    this.db = db;
    this.faults = faults;
    this.inTx = false;
  }

  exec(query, ...params) {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|END|SAVEPOINT|RELEASE)\b/i.test(query)) {
      throw new Error("Use ctx.storage.transactionSync(); SQL transaction statements are not allowed");
    }

    for (const fault of this.faults) {
      if (fault.remaining > 0 && fault.match.test(query) && (!fault.when || fault.when(query, params, this.db))) {
        fault.remaining--;
        throw new Error(`SQLITE_IOERR: injected fault (${fault.match})`);
      }
    }

    for (const p of params) {
      if (!(p === null || typeof p === "number" || typeof p === "string" || typeof p === "bigint")) {
        throw new TypeError(`Unsupported SQL parameter type: ${typeof p}`);
      }
    }

    const stmt = this.db.prepare(query);
    const isSelect = /^\s*(SELECT|WITH|PRAGMA)\b/i.test(query);
    const returns = isSelect || /\bRETURNING\b/i.test(query);
    let rows = [];
    let written = 0;

    if (returns) {
      rows = stmt.all(...params).map(r => ({ ...r }));
      if (!isSelect) written = rows.length;
    } else {
      written = Number(stmt.run(...params).changes);
    }

    return {
      toArray: () => rows,
      one: () => {
        if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
        return rows[0];
      },
      rowsRead: rows.length,
      rowsWritten: written,
      [Symbol.iterator]: () => rows[Symbol.iterator]()
    };
  }
}

export class DONamespaceEmu {
  constructor(Cls, env, clock) {
    this.Cls = Cls;
    this.env = env;
    this.clock = clock;
    this.dir = mkdtempSync(path.join(tmpdir(), "pride-do-"));
    this.objects = new Map();
    this.alarms = new Map(); // переживают перезапуск
    this.faults = [];
    this.rpcDelay = [0, 3];
  }

  idFromName(name) {
    return { name, toString: () => name };
  }

  get(id) {
    const name = id.name;
    return new Proxy({}, {
      get: (_, method) => {
        if (method === "then") return undefined;
        return async (...args) => {
          await sleep(rand(...this.rpcDelay));
          const obj = this.instance(name);
          await obj.ready;
          if (typeof obj.inst[method] !== "function") throw new Error(`No RPC method ${String(method)}`);
          return clone(await obj.inst[method](...clone(args)));
        };
      }
    });
  }

  instance(name) {
    let obj = this.objects.get(name);
    if (obj) return obj;

    const db = new DatabaseSync(path.join(this.dir, `${name}.sqlite`));
    const sql = new SqlStorageEmu(db, this.faults);
    const alarms = this.alarms;

    const storage = {
      sql,
      transactionSync(fn) {
        if (sql.inTx) throw new Error("Nested transactionSync is not supported in this emulator");
        sql.inTx = true;
        db.exec("BEGIN");
        try {
          const result = fn();
          if (result && typeof result.then === "function") throw new Error("transactionSync callback must be synchronous");
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        } finally {
          sql.inTx = false;
        }
      },
      async getAlarm() { return alarms.has(name) ? alarms.get(name) : null; },
      async setAlarm(t) { alarms.set(name, Number(t)); },
      async deleteAlarm() { alarms.delete(name); }
    };

    let ready = Promise.resolve();
    const ctx = {
      id: { name },
      storage,
      blockConcurrencyWhile(fn) { ready = Promise.resolve(fn()); return ready; },  // как в Cloudflare: колбэк стартует сразу
      waitUntil() {}
    };

    const inst = new this.Cls(ctx, this.env);
    obj = { inst, db, ready };
    this.objects.set(name, obj);
    return obj;
  }

  /** «Перезапуск»: экземпляр и его память теряются, остаются SQLite-файл и будильник. */
  restart(name) {
    const obj = this.objects.get(name);
    if (obj) {
      this.objects.delete(name);
      // Старый экземпляр мог «зависнуть» в await — его соединение просто бросаем.
    }
  }

  async fireDueAlarms() {
    let fired = 0;
    for (const [name, at] of [...this.alarms]) {
      if (at <= this.clock.now) {
        this.alarms.delete(name);
        const obj = this.instance(name);
        await obj.ready;
        await obj.inst.alarm();
        fired++;
      }
    }
    return fired;
  }

  query(name, q, ...params) {
    return this.instance(name).db.prepare(q).all(...params).map(r => ({ ...r }));
  }

  cleanup() {
    for (const obj of this.objects.values()) {
      try { obj.db.close(); } catch (_) {}
    }
    try { rmSync(this.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch (_) { /* Windows: файл SQLite ещё занят, временная папка */ }
  }
}

export class KVMock {
  constructor() { this.store = new Map(); this.writes = 0; }
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) { this.writes++; this.store.set(key, String(value)); }
  async delete(key) { this.writes++; this.store.delete(key); }
  async list({ prefix = "", cursor } = {}) {
    const names = [...this.store.keys()].filter(k => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const page = names.slice(start, start + 2);  // маленькие страницы, чтобы проверить пагинацию
    const next = start + page.length;
    return { keys: page.map(name => ({ name })), list_complete: next >= names.length, cursor: String(next) };
  }
}

export class TelegramMock {
  constructor({ botId, admins = [] }) {
    this.botId = botId;
    this.admins = new Set(admins.map(String));
    this.messages = new Map(); // `${chat}:${id}` → message
    this.nextId = 5000;
    this.pinned = new Set();
    this.calls = [];
    this.rules = [];
    this.answers = [];
    this.realFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => this.handle(url, init);
  }

  restore() { globalThis.fetch = this.realFetch; }

  /** action: 'network' | 'hang' | 'lost' | { code, description, retry_after } */
  failNext(method, action, { when = () => true, times = 1 } = {}) {
    this.rules.push({ method, action, when, times });
  }

  seedMessage(chatId, messageId, text, extra = {}) {
    this.messages.set(`${chatId}:${messageId}`, {
      message_id: messageId, chat: { id: Number(chatId) }, text, date: 0,
      from: { id: this.botId, is_bot: true }, reply_markup: null, ...extra
    });
  }

  chatMessages(chatId) {
    return [...this.messages.values()].filter(m => String(m.chat.id) === String(chatId)).sort((a, b) => a.message_id - b.message_id);
  }

  async handle(url, init) {
    const method = String(url).split("/").pop();
    const p = JSON.parse(init?.body || "{}");
    await sleep(rand(0, 4));

    const rule = this.rules.find(r => r.method === method && r.times > 0 && r.when(p));
    let lost = false;

    if (rule) {
      rule.times--;
      if (rule.action === "network") {
        this.calls.push({ method, p, failed: "network" });
        throw new TypeError("fetch failed (injected)");
      }
      if (rule.action === "hang") {
        this.calls.push({ method, p, failed: "hang" });
        return new Promise(() => {});
      }
      if (rule.action === "lost") lost = true;
      else {
        this.calls.push({ method, p, failed: rule.action.code });
        return this.reply({ ok: false, error_code: rule.action.code, description: rule.action.description,
          parameters: rule.action.retry_after ? { retry_after: rule.action.retry_after } : undefined });
      }
    }

    this.calls.push({ method, p });
    const result = this.perform(method, p);
    if (lost) {
      this.calls.at(-1).failed = "lost-response";
      throw new TypeError("connection reset after delivery (injected)");
    }
    return result;
  }

  reply(body) {
    return new Response(JSON.stringify(body), { status: body.ok ? 200 : (body.error_code || 400) });
  }

  perform(method, p) {
    const ok = result => this.reply({ ok: true, result });
    const bad = (code, description) => this.reply({ ok: false, error_code: code, description });

    switch (method) {
      case "sendMessage": {
        const id = this.nextId++;
        const msg = {
          message_id: id, chat: { id: Number(p.chat_id) }, text: p.text, date: Math.floor(Date.now() / 1000),
          from: { id: this.botId, is_bot: true }, entities: p.entities, reply_markup: p.reply_markup || null
        };
        this.messages.set(`${p.chat_id}:${id}`, msg);
        return ok(structuredClone(msg));
      }
      case "editMessageText": {
        const key = `${p.chat_id}:${p.message_id}`;
        const msg = this.messages.get(key);
        if (!msg) return bad(400, "Bad Request: message to edit not found");
        const markup = p.reply_markup || null;
        if (msg.text === p.text && JSON.stringify(msg.reply_markup) === JSON.stringify(markup)) {
          return bad(400, "Bad Request: message is not modified: specified new message content and reply markup are exactly the same");
        }
        msg.text = p.text;
        msg.reply_markup = markup;
        return ok(true);
      }
      case "deleteMessage": {
        const key = `${p.chat_id}:${p.message_id}`;
        if (!this.messages.has(key)) return bad(400, "Bad Request: message to delete not found");
        this.messages.delete(key);
        this.pinned.delete(key);
        return ok(true);
      }
      case "pinChatMessage": {
        const key = `${p.chat_id}:${p.message_id}`;
        if (!this.messages.has(key)) return bad(400, "Bad Request: message to pin not found");
        this.pinned.add(key);
        return ok(true);
      }
      case "unpinChatMessage": {
        const key = `${p.chat_id}:${p.message_id}`;
        if (!this.pinned.has(key)) return bad(400, "Bad Request: message to unpin not found");
        this.pinned.delete(key);
        return ok(true);
      }
      case "answerCallbackQuery":
        this.answers.push(p);
        return ok(true);
      case "getChatMember":
        return ok({ status: this.admins.has(String(p.user_id)) ? "administrator" : "member", user: { id: p.user_id } });
      case "setWebhook":
      case "getWebhookInfo":
        return ok(method === "setWebhook" ? true : { url: "x", pending_update_count: 0, max_connections: 40 });
      default:
        return bad(404, "Not Found: method not found");
    }
  }
}
