#!/usr/bin/env bash
# Самопроверка scripts/preflight.mjs: строгий режим на заполненной копии и на испорченных копиях.
# Работает только во временной копии проекта — рабочие файлы не изменяются.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp -r "$ROOT/src" "$ROOT/scripts" "$ROOT/test" "$ROOT/package.json" "$ROOT/.gitignore" "$ROOT/wrangler.jsonc" "$WORK/"
mkdir -p "$WORK/mini-app/dist" && echo "<!doctype html>" > "$WORK/mini-app/dist/index.html"   # заглушка сборки: только в копии
cd "$WORK" || exit 1
# В копии нет node_modules: берём esbuild из рабочего проекта (только чтение).
for c in "$ROOT/node_modules/esbuild" "$ROOT/node_modules/wrangler/node_modules/esbuild"; do
  [ -d "$c" ] && export PREFLIGHT_ESBUILD="$c" && break
done
PINNED="$(node -p "require('./package.json').devDependencies.wrangler")"
mkdir -p node_modules/wrangler
echo "{\"version\":\"$PINNED\"}" > node_modules/wrangler/package.json      # имитация установленного wrangler
echo "{\"lockfileVersion\":3,\"packages\":{\"node_modules/wrangler\":{\"version\":\"$PINNED\"}}}" > package-lock.json
fill() {
  cp "$ROOT/wrangler.jsonc" wrangler.jsonc
  sed -i 's/ВСТАВЬТЕ_ID_NAMESPACE_PRIDE_ONE_DEMO/0123456789abcdef0123456789abcdef/; s/ВСТАВЬТЕ_ID_ГРУППЫ_PRIDE_TEST/-1001234567890/' wrangler.jsonc
  printf 'ADMIN_SECRET=Xk3mP9qL2vN8rT5wY7zA4bC6\n' > .secrets.deploy.env
}
check() {
  echo "== $1"
  node --no-warnings scripts/preflight.mjs > out.txt
  echo "   exit=$?"
  grep -E "✖|⚠" out.txt | sed 's/^/   /'
  fill
}
fill
check "заполненная конфигурация (ожидается exit=0)"
sed -i 's/"new_sqlite_classes"/"new_classes"/' wrangler.jsonc;                        check "миграция new_classes (KV-хранилище)"
sed -i 's/"BRANCH_CHATS"/"BOT_TOKEN": "123:abc", "BRANCH_CHATS"/' wrangler.jsonc;      check "секрет в vars"
sed -i 's/"class_name": "BranchBookingDO"/"class_name": "BookingDO"/' wrangler.jsonc;  check "неверное имя класса"
sed -i 's/"compatibility_date": "2025-10-01"/"compatibility_date": "2024-01-01"/' wrangler.jsonc; check "дата совместимости до RPC"
sed -i 's/^export { BranchBookingDO };/\/\/ removed/' src/index.js;                   check "класс не экспортирован из Worker"
cp "$ROOT/src/index.js" src/index.js
rm package-lock.json;                                                                  check "нет package-lock.json"
echo "{\"lockfileVersion\":3,\"packages\":{\"node_modules/wrangler\":{\"version\":\"$PINNED\"}}}" > package-lock.json
printf 'ADMIN_SECRET=short\nBOT_TOKEN=1:x\n' > .secrets.deploy.env;                     check "слабый ADMIN_SECRET и лишний BOT_TOKEN"
sed -i 's/"id": "[0-9a-f]\{32\}"/"id": "ВСТАВЬТЕ_ID"/; s/\\"P03\\":\\"-[0-9]*\\"/\\"P03\\":\\"ВСТАВЬТЕ_ID_ГРУППЫ\\"/' wrangler.jsonc; check "заглушки KV и группы (создаются только в копии; ожидается exit=1)"
rm -rf mini-app/dist;                                                                  check "нет собранного Mini App (ожидается exit=1)"
echo "Реальный wrangler.jsonc не менялся: $(grep -c ВСТАВЬТЕ "$ROOT/wrangler.jsonc") заглушек в рабочей конфигурации"
