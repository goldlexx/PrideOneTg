#!/usr/bin/env node
/**
 * Предварительная проверка перед `wrangler deploy`. Ничего не отправляет в Cloudflare.
 *
 *   npm run check          — строгий режим перед развёртыванием (заглушки = ошибка)
 *   npm run check:local    — то же, но заглушки ID допускаются (для локальной разработки)
 *
 * Проверяет:
 *   1. wrangler.jsonc: имя, точка входа, дата совместимости, привязка Durable Object,
 *      миграция new_sqlite_classes, KV binding, BRANCH_CHATS, cron, отсутствие секретов в vars;
 *   2. сборку: Worker и Durable Object собираются в один ES-модуль тем же esbuild,
 *      что использует Wrangler; в бандле экспортируются default.fetch/scheduled и класс
 *      Durable Object со всеми RPC-методами; внешний импорт только «cloudflare:workers»;
 *   3. файл секретов для первого развёртывания (.secrets.deploy.env), если он есть.
 *
 * Официальная сборка без публикации: `npm run build:dry` (wrangler deploy --dry-run).
 */

import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOW_PLACEHOLDERS = process.argv.includes("--allow-placeholders");
const SECRETS_FILE = ".secrets.deploy.env";
const SECRET_NAMES = ["BOT_TOKEN", "WEBHOOK_SECRET", "ADMIN_SECRET"];

const results = [];
const ok = msg => results.push(["ok", msg]);
const warn = msg => results.push(["warn", msg]);
const fail = msg => results.push(["fail", msg]);
const placeholder = msg => (ALLOW_PLACEHOLDERS ? warn : fail)(msg);

/* ---------------------------- JSONC без зависимостей ---------------------- */

function parseJsonc(text) {
  let out = "";
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inString) {
      out += c;
      if (c === "\\") {
        out += next;
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }

  // Висячие запятые перед } и ] (разрешены в JSONC).
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/* ---------------------------- 1. конфигурация ----------------------------- */

const configPath = path.join(ROOT, "wrangler.jsonc");
let config;

try {
  config = parseJsonc(readFileSync(configPath, "utf8"));
  ok("wrangler.jsonc читается как JSONC");
} catch (error) {
  fail(`wrangler.jsonc не читается: ${error.message}`);
  report();
}

if (config.name === "pride-one-bot") ok("name = pride-one-bot (тот же Worker, что сейчас обслуживает webhook)");
else fail(`name = ${config.name}: ожидалось pride-one-bot, иначе будет создан новый Worker`);

const mainPath = path.join(ROOT, config.main || "");
if (config.main && existsSync(mainPath)) ok(`main = ${config.main}`);
else fail(`main не найден: ${config.main}`);

const compat = String(config.compatibility_date || "");
const today = new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(compat)) fail("compatibility_date не задана или в неверном формате");
else if (compat < "2024-04-03") fail(`compatibility_date ${compat} < 2024-04-03: RPC к Durable Objects недоступен`);
else if (compat > today) fail(`compatibility_date ${compat} в будущем`);
else ok(`compatibility_date = ${compat} (RPC к Durable Objects поддерживается)`);

if (config.workers_dev === true) ok("workers_dev = true (адрес *.workers.dev сохраняется)");
else warn("workers_dev не true: адрес *.workers.dev, на который настроен webhook, может перестать работать");

const doBindings = config.durable_objects?.bindings || [];
const doBinding = doBindings.find(b => b.name === "BRANCH_DO");
if (!doBinding) fail("нет привязки durable_objects.bindings с name = BRANCH_DO");
else if (doBinding.class_name !== "BranchBookingDO") fail(`BRANCH_DO.class_name = ${doBinding.class_name}, ожидалось BranchBookingDO`);
else if (doBinding.script_name) fail("BRANCH_DO.script_name задан: класс должен быть в этом же Worker");
else ok("привязка BRANCH_DO → BranchBookingDO (класс в этом же Worker)");

if (config.exports && config.migrations) {
  fail("заданы одновременно exports и migrations — Cloudflare отклонит такую конфигурацию");
}

const migrations = Array.isArray(config.migrations) ? config.migrations : [];
const tags = migrations.map(m => m.tag);
if (!migrations.length) fail("нет migrations: класс Durable Object не будет создан");
else if (new Set(tags).size !== tags.length || tags.some(t => !t)) fail(`теги миграций должны быть уникальны и непусты: ${tags.join(", ")}`);
else {
  const sqliteClasses = migrations.flatMap(m => m.new_sqlite_classes || []);
  const kvClasses = migrations.flatMap(m => m.new_classes || []);
  if (kvClasses.length) fail(`new_classes (KV-хранилище) недоступно на Workers Free: ${kvClasses.join(", ")}`);
  for (const b of doBindings) {
    if (!sqliteClasses.includes(b.class_name)) fail(`класс ${b.class_name} не объявлен в new_sqlite_classes`);
  }
  if (sqliteClasses.includes("BranchBookingDO") && migrations[0].tag === "v1") {
    ok("migrations: v1 → new_sqlite_classes [BranchBookingDO] (SQLite, доступно на Free)");
  }
  const destructive = migrations.filter(m => m.deleted_classes || m.renamed_classes || m.transferred_classes);
  if (destructive.length) fail("в миграциях есть deleted/renamed/transferred_classes — это изменяет или удаляет данные");
}

const kv = (config.kv_namespaces || []).find(k => k.binding === "PRIDE_KV");
if (!kv) fail("нет kv_namespaces с binding = PRIDE_KV (нужен для миграции старых данных)");
else if (/^[0-9a-f]{32}$/.test(String(kv.id || ""))) ok(`PRIDE_KV → namespace ${kv.id}`);
else placeholder(`PRIDE_KV.id = «${kv.id}» — это не ID namespace (32 шестнадцатеричных символа)`);
if (kv?.preview_id) warn("PRIDE_KV.preview_id задан: используется только для wrangler dev --remote");

const vars = config.vars || {};
for (const name of SECRET_NAMES) {
  if (name in vars) fail(`${name} указан в vars: секреты нельзя хранить в wrangler.jsonc (он попадёт в Dashboard открытым текстом)`);
}

let branchChats = null;
// BRANCH_CHATS is environment-specific and must stay out of tracked config.
// Prefer the ignored local .dev.vars file; CI may supply it as an environment variable.
const devVarsPath = path.join(ROOT, ".dev.vars");
let branchChatsValue = process.env.BRANCH_CHATS || vars.BRANCH_CHATS || "";
if (!branchChatsValue && existsSync(devVarsPath)) {
  const line = readFileSync(devVarsPath, "utf8").split(/\r?\n/)
    .find(entry => /^\s*BRANCH_CHATS\s*=/.test(entry));
  if (line) branchChatsValue = line.slice(line.indexOf("=") + 1).trim();
}
try {
  branchChats = JSON.parse(branchChatsValue);
  if (typeof branchChats === "string") branchChats = JSON.parse(branchChats);
} catch (_) {
  fail("BRANCH_CHATS не задан как JSON в .dev.vars, окружении или vars. Пример: {\"P03\":\"-1001234567890\"}");
}

if (branchChats) {
  const p03 = String(branchChats.P03 ?? "");
  if (/^-100\d{6,}$/.test(p03)) ok(`BRANCH_CHATS: P03 → ${p03}`);
  else if (/^-\d+$/.test(p03)) warn(`BRANCH_CHATS: P03 → ${p03} — похоже на обычную группу (не супергруппу); проверьте ID`);
  else placeholder(`BRANCH_CHATS.P03 = «${p03}» — это не ID группы (ожидается вида -100…)`);
}

/* Mini App: статические файлы раздаются тем же Worker (Workers Static Assets). */
const assets = config.assets;
if (!assets?.directory || assets.binding !== "ASSETS") fail("нет блока assets { directory, binding: \"ASSETS\" }: Mini App не будет раздаваться");
else {
  const dist = path.join(ROOT, assets.directory);
  if (existsSync(path.join(dist, "index.html"))) ok(`assets: ${assets.directory}/index.html собран`);
  else fail(`${assets.directory}/index.html не найден — выполните \`npm run mini:build\` (npm run verify делает это сам)`);
  if (assets.run_worker_first === true) fail("assets.run_worker_first = true: Worker перехватит «/» и вместо Mini App отдаст JSON /health");
  else ok("«/» отдаёт Mini App из assets, /health — Worker");
}

if (/ВСТАВЬТЕ|REPLACE_ME|replace-me|TODO_/i.test(readFileSync(configPath, "utf8").replace(/\/\/.*$/gm, ""))) {
  placeholder("в wrangler.jsonc остались шаблонные заглушки (ВСТАВЬТЕ… / replace-me)");
}

const crons = config.triggers?.crons || [];
if (crons.length > 5) fail("больше 5 cron-триггеров — превышение лимита бесплатного тарифа");
else if (crons.length) ok(`cron: ${crons.join(", ")}`);
else warn("нет cron: панель будет обновляться только будильником объекта и действиями в группе");

if (config.compatibility_flags?.length) warn(`compatibility_flags: ${config.compatibility_flags.join(", ")} — проект их не требует`);

/* ------------------------- 1б. зависимости и lock ------------------------- */

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const pinned = pkg.devDependencies?.wrangler || "";
const lockPath = path.join(ROOT, "package-lock.json");

if (!/^\d+\.\d+\.\d+$/.test(pinned)) fail(`wrangler в package.json не закреплён точной версией: «${pinned}»`);

if (!existsSync(lockPath)) {
  (ALLOW_PLACEHOLDERS ? warn : fail)("package-lock.json нет — выполните `npm install` один раз (см. FIRST_RUN.md, шаг 2)");
} else {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const locked = lock.packages?.["node_modules/wrangler"]?.version;
  if (locked === pinned) ok(`package-lock.json: wrangler ${locked} (совпадает с package.json)`);
  else fail(`package-lock.json: wrangler ${locked || "не найден"}, а в package.json ${pinned} — выполните \`npm install\``);
}

const installed = path.join(ROOT, "node_modules", "wrangler", "package.json");
if (existsSync(installed)) {
  const v = JSON.parse(readFileSync(installed, "utf8")).version;
  if (v === pinned) ok(`установлен wrangler ${v}`);
  else fail(`установлен wrangler ${v}, ожидался ${pinned} — выполните \`npm ci\``);
} else {
  (ALLOW_PLACEHOLDERS ? warn : fail)("wrangler не установлен — выполните `npm ci`");
}

/* ------------------------------- 2. сборка -------------------------------- */

let esbuild = null;
const require = createRequire(path.join(ROOT, "package.json"));

for (const candidate of [process.env.PREFLIGHT_ESBUILD, "esbuild", "wrangler/node_modules/esbuild"]) {
  if (!candidate) continue;
  try {
    esbuild = require(candidate);
    break;
  } catch (_) {
    // пробуем следующий путь
  }
}

if (!esbuild) {
  (ALLOW_PLACEHOLDERS ? warn : fail)("esbuild не найден — выполните `npm ci` (он ставится вместе с wrangler); сборка не проверена");
} else {
  const dir = mkdtempSync(path.join(tmpdir(), "pride-preflight-"));

  try {
    const built = await esbuild.build({
      entryPoints: [mainPath],
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:workers"],
      write: false,
      metafile: true,
      logLevel: "silent"
    });

    const code = built.outputFiles[0].text;
    const externals = new Set();
    for (const out of Object.values(built.metafile.outputs)) {
      for (const imp of out.imports || []) if (imp.external) externals.add(imp.path);
    }

    const unexpected = [...externals].filter(x => x !== "cloudflare:workers");
    if (unexpected.length) fail(`в бандле внешние импорты, которых нет в Workers без nodejs_compat: ${unexpected.join(", ")}`);
    else ok(`Worker и Durable Object собраны в один ES-модуль (${(code.length / 1024).toFixed(1)} КБ), внешний импорт: cloudflare:workers`);

    const bundlePath = path.join(dir, "bundle.mjs");
    writeFileSync(bundlePath, code);
    register(pathToFileURL(path.join(ROOT, "test", "loader.mjs")));
    const mod = await import(pathToFileURL(bundlePath).href);

    if (typeof mod.default?.fetch === "function") ok("export default { fetch } есть");
    else fail("нет export default { fetch }");
    if (crons.length && typeof mod.default?.scheduled !== "function") fail("cron задан, но нет export default { scheduled }");
    else if (typeof mod.default?.scheduled === "function") ok("export default { scheduled } есть");

    for (const b of doBindings) {
      const Cls = mod[b.class_name];
      if (typeof Cls !== "function") {
        fail(`класс ${b.class_name} не экспортируется из ${config.main}`);
        continue;
      }
      const methods = ["handleUpdate", "drain", "alarm", "tick", "status", "importLegacy", "apiSchedule", "apiMyBookings", "apiBook", "apiCancel"];
      const missing = methods.filter(m => typeof Cls.prototype[m] !== "function");
      if (missing.length) fail(`у ${b.class_name} нет методов: ${missing.join(", ")}`);
      else ok(`export class ${b.class_name} с методами ${methods.join(", ")}`);
    }

    const { BRANCHES } = await import(pathToFileURL(path.join(ROOT, "src", "branch-do.js")).href);
    for (const id of Object.keys(branchChats || {})) {
      if (!BRANCHES[id]) fail(`BRANCH_CHATS содержит филиал ${id}, которого нет в BRANCHES (src/branch-do.js)`);
    }
  } catch (error) {
    fail(`сборка не удалась: ${String(error.message || error).split("\n")[0]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------- 3. файл секретов деплоя ------------------------ */

const secretsPath = path.join(ROOT, SECRETS_FILE);

if (existsSync(secretsPath)) {
  const entries = {};
  for (const line of readFileSync(secretsPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) entries[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }

  if ((entries.ADMIN_SECRET || "").length >= 16) ok(`${SECRETS_FILE}: ADMIN_SECRET задан (${entries.ADMIN_SECRET.length} символов)`);
  else fail(`${SECRETS_FILE}: ADMIN_SECRET отсутствует или короче 16 символов`);

  for (const name of ["BOT_TOKEN", "WEBHOOK_SECRET"]) {
    if (name in entries) warn(`${SECRETS_FILE} содержит ${name}: он ЗАМЕНИТ текущее значение в Cloudflare. Если менять не нужно — удалите строку`);
  }

  const gitignore = existsSync(path.join(ROOT, ".gitignore")) ? readFileSync(path.join(ROOT, ".gitignore"), "utf8") : "";
  if (!gitignore.includes(SECRETS_FILE)) fail(`${SECRETS_FILE} не указан в .gitignore`);
} else {
  warn(`${SECRETS_FILE} нет — для первого развёртывания создайте его (см. README, шаг 6)`);
}

report();

function report() {
  const icon = { ok: "✔", warn: "⚠", fail: "✖" };
  console.log(`\nПредварительная проверка PRIDE ONE (${ALLOW_PLACEHOLDERS ? "локальный режим" : "строгий режим"})\n`);
  for (const [level, msg] of results) console.log(`${icon[level]} ${msg}`);
  const failed = results.filter(r => r[0] === "fail").length;
  const warned = results.filter(r => r[0] === "warn").length;
  console.log(`\nИтог: ошибок ${failed}, предупреждений ${warned}. В Cloudflare ничего не отправлялось.`);
  process.exit(failed ? 1 : 0);
}
