// PRIDE ONE — Telegram Mini App. Без фреймворков: один модуль, данные берутся только из API Worker.

// Telegram подставляет initData в адрес (#tgWebAppData=...). Читаем его оттуда сами, чтобы приложение
// не зависело от внешнего скрипта telegram.org: он подключён асинхронно и может грузиться долго или не грузиться вовсе.
const hashParams = new URLSearchParams(location.hash.slice(1));
const initData = window.Telegram?.WebApp?.initData || hashParams.get("tgWebAppData") || new URLSearchParams(location.search).get("dev_init") || "";

function setupTelegram() {
  const tg = window.Telegram?.WebApp;
  if (!tg) return false;
  tg.ready();
  tg.expand();
  try { tg.disableVerticalSwipes?.(); tg.setHeaderColor?.("#0b0b0c"); tg.setBackgroundColor?.("#0b0b0c"); tg.setBottomBarColor?.("#0b0b0c"); } catch (_) { /* не критично */ }
  return true;
}

// Убирает индикатор загрузки Telegram, даже если скрипт telegram.org ещё не загрузился.
function postReadyFallback() {
  try {
    if (window.TelegramWebviewProxy?.postEvent) window.TelegramWebviewProxy.postEvent("web_app_ready", "{}");
    else if (window.parent !== window) window.parent.postMessage(JSON.stringify({ eventType: "web_app_ready", eventData: {} }), "https://web.telegram.org");
  } catch (_) { /* не критично */ }
}

if (!setupTelegram()) {
  postReadyFallback();
  window.addEventListener("load", setupTelegram, { once: true });
  document.querySelector('script[src*="telegram-web-app"]')?.addEventListener("load", setupTelegram, { once: true });
}
const tg = window.Telegram?.WebApp;

const $ = id => document.getElementById(id);
const view = $("view");
const state = {
  tab: "schedule",
  branches: [],
  branchId: null,
  schedule: null,       // ответ /api/schedule
  date: null,           // выбранная дата
  my: null              // ответ /api/my
};

const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];

/* ---------------------------------- API ---------------------------------- */

async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      signal: AbortSignal.timeout(15000),
      method,
      headers: { Authorization: `tma ${initData}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (_) {
    return { ok: false, code: "network", message: "Нет соединения. Проверьте интернет и попробуйте ещё раз." };
  }
  const data = await res.json().catch(() => null);
  if (!data) return { ok: false, code: "bad_response", message: "Сервер ответил некорректно. Попробуйте ещё раз." };
  return data;
}

/* --------------------------------- утилиты -------------------------------- */

const SVG_NS = "http://www.w3.org/2000/svg";

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
}

function crossIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "ico");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M6 6l12 12M18 6 6 18");
  svg.append(path);
  return svg;
}

const plural = n => {
  const a = n % 10, b = n % 100;
  if (b >= 11 && b <= 14) return "детей";
  if (a === 1) return "ребёнок";
  if (a >= 2 && a <= 4) return "ребёнка";
  return "детей";
};

let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

function haptic(kind) { try { window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred(kind); } catch (_) { /* не критично */ } }

function stateBox(text, retry) {
  return el("div", { class: "state" }, el("div", { text }), retry ? el("button", { class: "btn", text: "Повторить", onclick: retry }) : null);
}

function skeleton() {
  return el("div", {}, el("div", { class: "skeleton" }), el("div", { class: "skeleton" }));
}

const selectedBranch = () => state.branches.find(b => b.id === state.branchId);

/* ------------------------------- расписание ------------------------------- */

async function loadSchedule() {
  view.replaceChildren(skeleton());
  const data = await api(`/api/schedule?branch=${encodeURIComponent(state.branchId)}`);
  if (!data.ok) { view.replaceChildren(stateBox(data.message, loadSchedule)); return; }
  state.schedule = data;
  ensureDate();
  renderSchedule(true);
}

// Ближайшая дата, где есть хотя бы один открытый слот (сегодняшний день мог уже закончиться).
function firstOpenDate(days) {
  return (days.find(d => d.slots.some(s => s.open)) || days[0])?.date ?? null;
}

// Сохраняет выбор пользователя, пока такая дата есть в расписании; иначе выбирает ближайшую открытую.
function ensureDate() {
  if (!state.schedule.days.some(d => d.date === state.date)) state.date = firstOpenDate(state.schedule.days);
}

function monthLabel(date) {
  const [y, m] = date.split("-").map(Number);
  return el("div", { class: "month" }, MONTHS[m - 1], " ", el("b", { text: String(y) }));
}

/**
 * Telegram Desktop: колесо мыши и трекпад. Вертикальное колесо над лентой листает её горизонтально (если лента
 * не помещается), жест трекпада deltaX работает сам; плюс перетаскивание мышью. Тач-свайп на телефоне не затронут.
 * Если все даты помещаются (обычно три), лента не прокручивается и страница листается как обычно.
 */
function enableDesktopScroll(strip) {
  strip.addEventListener("wheel", e => {
    if (strip.scrollWidth <= strip.clientWidth + 1) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!delta) return;
    const before = strip.scrollLeft;
    strip.scrollLeft += delta;
    if (strip.scrollLeft !== before) e.preventDefault();      // докрутили до края — дальше листается страница
  }, { passive: false });

  let drag = null;
  strip.addEventListener("pointerdown", e => {
    if (e.pointerType !== "mouse" || e.button !== 0 || strip.scrollWidth <= strip.clientWidth + 1) return;
    drag = { x: e.clientX, left: strip.scrollLeft, moved: false };
  });
  window.addEventListener("pointermove", e => {
    if (!drag || !strip.isConnected) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 5) return;
    drag.moved = true;
    strip.classList.add("dragging");
    strip.scrollLeft = drag.left - dx;
  });
  window.addEventListener("pointerup", () => {
    if (drag?.moved) strip.dataset.justDragged = "1";           // не считать окончание перетаскивания нажатием на дату
    setTimeout(() => { delete strip.dataset.justDragged; }, 0);
    strip.classList.remove("dragging");
    drag = null;
  });
  strip.addEventListener("click", e => {
    if (strip.dataset.justDragged) { e.stopPropagation(); e.preventDefault(); }
  }, true);
}

function renderSchedule(scrollToSelected = false) {
  const s = state.schedule;
  if (!s || !s.days.length) { view.replaceChildren(stateBox("Ближайших занятий нет.")); return; }

  const keepScroll = view.querySelector(".dates")?.scrollLeft ?? 0;

  const dates = el("div", { class: "dates", role: "tablist" }, s.days.map(day => {
    const [weekday, dm] = day.short.split(" ");
    return el("button", {
      class: `date${day.date === state.date ? " active" : ""}`, role: "tab", "aria-selected": String(day.date === state.date),
      "aria-label": day.label,
      onclick: () => { state.date = day.date; renderSchedule(); }
    }, el("small", { text: weekday }), el("strong", { text: String(Number(dm.slice(0, 2))) }));
  }));

  const day = s.days.find(d => d.date === state.date);
  const cards = day.slots.map(slot => slotCard(day, slot));
  enableDesktopScroll(dates);

  view.replaceChildren(monthLabel(day.date), dates, ...cards);

  if (scrollToSelected) dates.querySelector(".date.active")?.scrollIntoView({ inline: "center", block: "nearest" });
  else dates.scrollLeft = keepScroll;
}

function slotCard(day, slot) {
  const mine = slot.children.filter(c => c.mine);

  const kids = slot.children.length
    ? el("ul", { class: "kids" }, slot.children.map(c => el("li", { class: `kid${c.mine ? " mine" : ""}` },
        el("span", { text: c.name }),
        c.mine && slot.open && c.booking_id
          ? el("button", { class: "x", "aria-label": `Отменить запись: ${c.name}`, onclick: () => confirmCancel({
              id: c.booking_id, branch_id: state.branchId, branch_name: selectedBranch()?.name, child_name: c.name, label: day.label, time: slot.time, late: c.late === true
            }) }, crossIcon())
          : null)))
    : el("div", { class: "empty", text: "Пока никто не записан" });

  const action = slot.open
    ? el("button", { class: "btn block", text: mine.length ? "Записать ещё одного ребёнка" : "Записать ребёнка", onclick: () => openBooking(day, slot) })
    : el("button", { class: "btn block", text: "Запись закрыта", disabled: true });

  return el("section", { class: "card" },
    el("div", { class: "slot-head" },
      el("span", { class: "time", text: slot.time }),
      el("span", { class: `count${slot.count ? " has" : ""}`, text: `${slot.count} ${plural(slot.count)}` })),
    kids,
    mine.length && slot.open ? el("div", { class: "hint", text: "Крестик рядом с именем отменяет запись только этого ребёнка." }) : null,
    action,
    slot.open ? null : el("div", { class: "hint", text: "Занятие уже началось или прошло." }));
}

/* --------------------------------- запись --------------------------------- */

function openSheet(...nodes) {
  $("sheetContent").replaceChildren(...nodes);
  $("sheet").hidden = false;
}
function closeSheet() { $("sheet").hidden = true; }
document.querySelector("[data-close]").addEventListener("click", closeSheet);

function openBooking(day, slot) {
  const input = el("input", { type: "text", maxlength: "40", placeholder: "Имя ребёнка", autocomplete: "off", enterkeyhint: "done", "aria-label": "Имя ребёнка" });
  const err = el("div", { class: "err", role: "alert" });
  const submit = el("button", { class: "btn", text: "Записать" });

  async function send() {
    const name = input.value.trim();
    if (name.length < 2) { err.textContent = "Укажите имя ребёнка (от 2 символов)."; input.focus(); return; }
    submit.disabled = true;
    submit.textContent = "Записываем…";
    err.textContent = "";
    const r = await api("/api/book", { method: "POST", body: { branch: state.branchId, date: day.date, time: slot.time, child_name: name } });
    if (r.ok) {
      haptic("success");
      showBooked(r.booking, day);
      state.my = null;
      loadMy(true);
      refreshScheduleQuietly();
      return;
    }
    haptic("error");
    err.textContent = r.message;
    submit.disabled = false;
    submit.textContent = "Записать";
    if (["slot_closed", "duplicate"].includes(r.code)) refreshScheduleQuietly();
  }

  submit.addEventListener("click", send);
  input.addEventListener("keydown", e => { if (e.key === "Enter") send(); });

  openSheet(
    el("h3", { id: "sheetTitle", text: "Запись на тренировку" }),
    el("p", {}, el("b", { text: `${day.label}, ${slot.time}` }), ` · ${selectedBranch().name}`),
    input, err,
    el("div", { class: "row" }, el("button", { class: "btn ghost", text: "Отмена", onclick: closeSheet }), submit)
  );
  setTimeout(() => input.focus(), 120);
}

function showBooked(booking, day) {
  openSheet(
    el("div", { class: "ok-mark", text: "✓" }),
    el("h3", { id: "sheetTitle", text: "Вы записаны", style: "text-align:center" }),
    el("p", { style: "text-align:center" }, el("b", { text: booking.child_name }), ` · ${day.label}, ${booking.time}`),
    el("button", { class: "btn", style: "width:100%", text: "Готово", onclick: closeSheet })
  );
}

async function refreshScheduleQuietly() {
  const data = await api(`/api/schedule?branch=${encodeURIComponent(state.branchId)}`);
  if (data.ok) { state.schedule = data; ensureDate(); if (state.tab === "schedule") renderSchedule(); }
}

/* ----------------------- возврат из фонового режима ----------------------- */
// Telegram держит приложение открытым в свёрнутом окне. При возврате обновляем данные: филиал, дата и
// открытые окна не сбрасываются. Не чаще раза в 10 с и не параллельно (visibilitychange приходит пачками).
let resumeBusy = false;
let lastResume = 0;
async function refreshOnResume() {
  if (document.hidden || !state.branchId || resumeBusy || Date.now() - lastResume < 10000) return;
  resumeBusy = true;
  lastResume = Date.now();
  try {
    await Promise.all([refreshScheduleQuietly(), loadMy(true)]);
  } finally {
    resumeBusy = false;
  }
}
document.addEventListener("visibilitychange", refreshOnResume);
window.addEventListener("focus", refreshOnResume);
window.Telegram?.WebApp?.onEvent?.("activated", refreshOnResume);

/* ------------------------------- мои записи ------------------------------- */

async function loadMy(silent = false) {
  if (!silent && state.tab === "my") view.replaceChildren(skeleton());
  const data = await api("/api/my");
  if (!data.ok) { if (state.tab === "my") view.replaceChildren(stateBox(data.message, () => loadMy())); return; }
  state.my = data.bookings;
  const badge = $("myBadge");
  badge.hidden = !data.bookings.length;
  badge.textContent = data.bookings.length;
  if (state.tab === "my") renderMy();
}

function renderMy() {
  const list = state.my || [];
  if (!list.length) {
    view.replaceChildren(stateBox("У вас нет будущих записей. Выберите занятие в расписании."));
    return;
  }

  view.replaceChildren(
    el("h2", { class: "sec", text: "Будущие записи" }),
    ...list.map(b => el("section", { class: "card booking" },
      el("div", {},
        el("div", { class: "who", text: b.child_name }),
        el("div", { class: "when" }, el("b", { text: b.time }), b.label),
        el("div", { class: "meta", text: b.branch_name })),
      el("button", { class: "btn outline", text: "Отменить", onclick: () => confirmCancel(b) })))
  );
}

const LATE_WARNING = "До начала занятия менее 3 часов. При отмене занятие будет считаться использованным. Отменить запись?";

function confirmCancel(b) {
  const yes = el("button", { class: "btn danger", text: b.late ? "Да, отменить (поздняя отмена)" : "Да, отменить" });
  yes.addEventListener("click", async () => {
    yes.disabled = true;
    yes.textContent = "Отменяем…";
    // Для поздней отмены подтверждение отправляется явно; сервер сам проверяет время (оно могло измениться).
    const r = await api("/api/cancel", { method: "POST", body: { branch: b.branch_id, booking_id: b.id, ...(b.late ? { confirm_late: true } : {}) } });
    if (r.code === "late_confirm_required") { confirmCancel({ ...b, late: true }); return; }
    closeSheet();
    if (r.ok || r.code === "already") {
      haptic("success");
      toast(r.late ? `Поздняя отмена: ${b.child_name}. Занятие считается использованным.` : `Запись отменена: ${b.child_name}`);
    } else {
      haptic("error");
      toast(r.message);
    }
    await loadMy(true);
    refreshScheduleQuietly();
  });

  openSheet(
    el("h3", { id: "sheetTitle", text: "Отменить запись?" }),
    el("p", {}, el("b", { text: b.child_name }), ` · ${b.label}, ${b.time}${b.branch_name ? ` · ${b.branch_name}` : ""}. Другие записи не затрагиваются.`),
    b.late ? el("p", { class: "err", role: "alert", text: LATE_WARNING }) : null,
    el("div", { class: "row" }, el("button", { class: "btn ghost", text: "Оставить", onclick: closeSheet }), yes)
  );
}

/* ------------------------- шапка, вкладки и запуск ------------------------ */

function renderBranch() {
  const multi = state.branches.length > 1;
  $("branchBox").hidden = !state.branchId;
  $("branchBox").classList.toggle("pick", multi);
  $("branchChevron").hidden = !multi;
  $("branch").hidden = !multi;
  $("branchName").textContent = selectedBranch()?.name ?? "";
  $("branch").value = state.branchId;
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  if (tab === "schedule") {
    state.schedule ? renderSchedule(true) : loadSchedule();
    if (state.schedule) refreshScheduleQuietly();
  } else {
    state.my ? renderMy() : loadMy();
    loadMy(true);
  }
}

document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));

async function start() {
  if (!initData) {
    view.replaceChildren(stateBox("Откройте приложение из Telegram: через кнопку у бота PRIDE ONE."));
    return;
  }

  view.replaceChildren(skeleton());
  const data = await api("/api/branches");
  if (!data.ok) { view.replaceChildren(stateBox(data.message, start)); return; }

  state.branches = data.branches;
  if (!state.branches.length) {
    view.replaceChildren(stateBox("Запись доступна только участникам группы филиала. Вступите в группу PRIDE ONE и откройте приложение снова."));
    return;
  }

  const select = $("branch");
  select.replaceChildren(...state.branches.map(b => el("option", { value: b.id, text: b.name })));
  select.addEventListener("change", () => {
    state.branchId = select.value;
    state.schedule = null;
    state.date = null;
    renderBranch();
    loadSchedule();
  });

  state.branchId = state.branches[0].id;
  renderBranch();
  setTab("schedule");
  loadMy(true);
}

start();
