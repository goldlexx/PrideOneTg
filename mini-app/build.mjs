// Сборка Mini App: копирует mini-app/src → mini-app/dist (без зависимостей и бандлеров).
// Добавляет к styles.css/app.js хеш содержимого, чтобы Telegram не держал старый кеш.
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, cpSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, "src");
const dist = path.join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const hash = name => createHash("sha256").update(readFileSync(path.join(src, name))).digest("hex").slice(0, 8);
const v = { css: hash("styles.css"), js: hash("app.js") };

for (const file of readdirSync(src)) {
  if (file === "assets") { cpSync(path.join(src, file), path.join(dist, file), { recursive: true }); continue; }
  let data = readFileSync(path.join(src, file));
  if (file === "index.html") {
    data = Buffer.from(
      data.toString("utf8").replace("./styles.css", `./styles.css?v=${v.css}`).replace("./app.js", `./app.js?v=${v.js}`)
    );
  }
  writeFileSync(path.join(dist, file), data);
}

console.log(`mini-app собран: ${readdirSync(dist).join(", ")} → ${path.relative(process.cwd(), dist) || "dist"}`);
