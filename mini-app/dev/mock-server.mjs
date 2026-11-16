// ЛОКАЛЬНЫЙ макет для просмотра интерфейса БЕЗ Telegram и без Worker.
// Раздаёт mini-app/dist и имитирует /api/* в памяти. Подпись initData здесь НЕ проверяется — только для разработки.
// Расписание — то же, что в конфигурации Worker (P03: вт и чт 18:00/19:00, вс 12:00/13:00).
// Запуск: npm run mini:dev  →  http://localhost:5173/?dev_init=mock
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const SCHEDULE = { 2: ["18:00", "19:00"], 4: ["18:00", "19:00"], 0: ["12:00", "13:00"] };
const ME = "me";
const bookings = [];
let seq = 1;

const ymd = d => d.toISOString().slice(0, 10);
const label = s => { const t = new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "numeric", month: "long", weekday: "long" }).format(new Date(s + "T12:00:00Z")); return t[0].toUpperCase() + t.slice(1); };
const short = s => `${["Вс","Пн","Вт","Ср","Чт","Пт","Сб"][new Date(s + "T12:00:00Z").getUTCDay()]} ${s.slice(8)}.${s.slice(5, 7)}`;
const send = (res, data, status = 200) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data)); };

// Пара «чужих» записей, чтобы видеть список участников.
const first = (() => { for (let i = 0; i < 14; i++) { const d = new Date(Date.now() + i * 864e5); if (SCHEDULE[d.getUTCDay()]) return ymd(d); } })();
bookings.push({ id: "x1", date: first, time: SCHEDULE[new Date(first + "T12:00:00Z").getUTCDay()][0], child: "Маша", parent: "other" });
bookings.push({ id: "x2", date: first, time: SCHEDULE[new Date(first + "T12:00:00Z").getUTCDay()][0], child: "Ваня", parent: "other" });

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    let body = {};
    if (req.method === "POST") { let t = ""; for await (const c of req) t += c; body = JSON.parse(t || "{}"); }
    if (url.pathname === "/api/branches") return send(res, { ok: true, user: { first_name: "Тест" }, branches: [{ id: "P03", name: "Пролетарская" }] });
    if (url.pathname === "/api/schedule") {
      const days = [];
      const limit = Number(url.searchParams.get("n")) || 3;   // как сервер: три ближайшие даты (?n=8 — для проверки прокрутки)
      for (let i = 0; i < 28 && days.length < limit; i++) {
        const date = ymd(new Date(Date.now() + i * 864e5));
        const times = SCHEDULE[new Date(date + "T12:00:00Z").getUTCDay()];
        if (!times) continue;
        days.push({ date, label: label(date), short: short(date), slots: times.map(time => {
          const children = bookings.filter(b => b.date === date && b.time === time).map(b => ({ name: b.child, mine: b.parent === ME, ...(b.parent === ME ? { booking_id: b.id } : {}) }));
          return { time, count: children.length, children, open: true };
        }) });
      }
      return send(res, { ok: true, branch: { id: "P03", name: "Пролетарская" }, today: ymd(new Date()), days });
    }
    if (url.pathname === "/api/my") return send(res, { ok: true, bookings: bookings.filter(b => b.parent === ME).map(b => ({ id: b.id, branch_id: "P03", branch_name: "Пролетарская", date: b.date, label: label(b.date), short: short(b.date), time: b.time, child_name: b.child })) });
    if (url.pathname === "/api/book") {
      const name = String(body.child_name || "").trim();
      if (name.length < 2) return send(res, { ok: false, code: "bad_name", message: "Укажите имя ребёнка от 2 до 40 символов." }, 409);
      if (bookings.some(b => b.parent === ME && b.date === body.date && b.time === body.time && b.child.toLowerCase() === name.toLowerCase()))
        return send(res, { ok: false, code: "duplicate", message: `${name} уже записан(а) на ${label(body.date)}, ${body.time}.` }, 409);
      const b = { id: "m" + seq++, date: body.date, time: body.time, child: name, parent: ME };
      bookings.push(b);
      return send(res, { ok: true, code: "booked", message: "Запись создана.", booking: { id: b.id, date: b.date, time: b.time, child_name: name, branch_id: "P03", branch_name: "Пролетарская" } });
    }
    if (url.pathname === "/api/cancel") {
      const i = bookings.findIndex(b => b.id === body.booking_id && b.parent === ME);
      if (i < 0) return send(res, { ok: false, code: "not_found", message: "Запись не найдена." }, 409);
      bookings.splice(i, 1);
      return send(res, { ok: true, code: "cancelled", message: "Запись отменена." });
    }
    return send(res, { ok: false, message: "Не найдено." }, 404);
  }
  const file = path.join(dist, url.pathname === "/" ? "index.html" : url.pathname);
  if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404); return res.end("not found"); }
  const type = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css" }[path.extname(file)] || "application/octet-stream";
  res.writeHead(200, { "content-type": type }); res.end(readFileSync(file));
}).listen(5173, () => console.log("Макет Mini App: http://localhost:5173/?dev_init=mock"));
