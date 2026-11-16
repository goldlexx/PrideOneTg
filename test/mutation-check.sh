#!/usr/bin/env bash
# Мутационная проверка: ломаем по одной защите в копии проекта и убеждаемся, что тесты это ловят.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
run() {
  local name="$1" from="$2" to="$3"
  local tmp; tmp="$(mktemp -d)"
  cp -r "$ROOT/src" "$ROOT/test" "$ROOT/package.json" "$tmp/"
  python3 - "$tmp/src/branch-do.js" "$from" "$to" << 'PY'
import sys; p, a, b = sys.argv[1:4]; s = open(p).read()
assert a in s, "pattern not found: " + a
open(p, "w").write(s.replace(a, b, 1))
PY
  local out; out="$(cd "$tmp" && node --no-warnings --import ./test/register.mjs --test --test-concurrency=1 test/bot.test.mjs test/messages.test.mjs test/cancel-notice.test.mjs test/upgrade.test.mjs 2>&1)"
  local failed; failed="$(echo "$out" | grep -E '^not ok' | sed -E 's/^not ok [0-9]+ - //' | sed -E 's/\..*//' | paste -sd ' ' -)"
  echo "МУТАЦИЯ: $name"
  echo "  упавшие тесты: ${failed:-НЕТ (мутация не обнаружена!)}"
  rm -rf "$tmp"
}
run "нет уникального индекса активной брони" \
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_bookings_active_child" "CREATE INDEX IF NOT EXISTS ux_bookings_active_child"
run "нет проверки повторного update_id" \
  "if (seen) return { duplicate: true, code: seen.result };" "if (false) return { duplicate: true };"
run "нет транзакции (операции не атомарны)" \
  "return this.ctx.storage.transactionSync(fn);" "return fn();"
run "нет проверки владельца в JS (остаётся проверка в SQL)" \
  "if (booking.parent_id !== userId) {" "if (false) {"
run "общий список рисуется только при создании (без обновления)" \
  "if (stored && stored.chat_id === chatId) {" "if (stored && stored.chat_id === chatId) { return 'frozen';"
run "нет повторов outbox (ошибка = сразу failed)" \
  "if (permanent || attempts >= OUTBOX_MAX_ATTEMPTS) {" "if (true) {"
run "/init всегда публикует новую панель (как в версии 2.0.0)" \
  "if (stored && stored.chat_id === chatId) {
      // Панель уже есть" "if (false) {
      // Панель уже есть"
run "сетевая ошибка правки панели → публикация новой" \
  "        // поэтому повторяем именно правку, а не публикуем новое сообщение.
        if (!isMessageGone(error)) throw error;" "        // мутация"
run "сетевая ошибка правки общего списка → публикация нового" \
  "        if (!isMessageGone(error)) throw error;
        // Сообщение удалили вручную" "        // мутация"
# --- уведомление об отмене (2.0.2) ---
run "уведомление об отмене не отправляется" \
  'case "cancel_notice": return this.exCancelNotice(payload);' 'case "cancel_notice": return "mutation: noop";'
run "уведомление ставится и при повторном нажатии на отменённую запись" \
  'return { kind: "callback", code: "cancel_already",' 'this.enqueue("cancel_notice", { booking_id: booking.id }, { priority: PRIORITY.urgent }); return { kind: "callback", code: "cancel_already",'
run "у задачи уведомления нет ключа дедупликации" \
  '{ dedupeKey: `cancel_notice:${booking.id}`, priority: PRIORITY.urgent }' '{ priority: PRIORITY.urgent }'
run "нет проверки «уведомление уже отправлено»" \
  'if (this.getMeta(metaKey)) return "skipped: already sent";' '/* mutation */'
run "отметка об отправке уведомления не сохраняется" \
  'this.setMeta(metaKey, JSON.stringify({ message_id: sent.message_id, at: this.now() }));' '/* mutation */'
run "старые отметки об уведомлениях не очищаются" \
  "DELETE FROM meta WHERE key LIKE 'cancel_notice:%'" "DELETE FROM meta WHERE key LIKE 'zzz_none:%'"
# --- обновление и откат (2.0.2) ---
run "в схему SQLite добавлена новая таблица (структура БД изменилась)" \
  'const SCHEMA = [' 'const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS zz_extra (x INTEGER)`,'
run "при обновлении кода данные сбрасываются (миграция схемы пересоздаёт брони)" \
  'if (this.getMeta("schema_version") !== SCHEMA_VERSION) this.setMeta("schema_version", SCHEMA_VERSION);' 'this.run("DELETE FROM bookings");'
