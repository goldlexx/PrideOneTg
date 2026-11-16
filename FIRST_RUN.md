# Первый запуск PRIDE ONE Booking Bot 2.0.1

Порядок построен так, чтобы в Cloudflare было **ровно одно развёртывание кода** (шаг 8). До него все
команды только читают данные или работают локально. В каждом шаге указано, что он меняет.

> **Почему не `wrangler secret put`.** По документации Cloudflare `wrangler secret put` сразу создаёт
> и **разворачивает** новую версию Worker. Если выполнить его до `wrangler deploy`, в работу уйдёт текущий
> старый код с новым секретом — это лишнее развёртывание. Поэтому `ADMIN_SECRET` загружается вместе с кодом
> одной командой: `wrangler deploy --secrets-file`. Секреты, которых нет в файле (`BOT_TOKEN`,
> `WEBHOOK_SECRET`), по документации сохраняются из предыдущей версии.

> **Отката к старой версии после шага 8 нет.** Шаг 8 создаёт класс Durable Object (миграция `v1`).
> По документации Cloudflare откат на версию, развёрнутую до такой миграции, невозможен. Откатываться
> можно только между версиями 2.x. Старые данные KV остаются нетронутыми. Аварийная остановка описана в конце.

Все команды выполняются в папке проекта. В Windows PowerShell пишите `curl.exe` вместо `curl`.
Ниже `<URL>` = `https://pride-one-bot.rustik-yuldashev.workers.dev`.

---

## Подготовка — в Cloudflare ничего не меняется

**1. Node.js 22.13 или новее.** Проверка: `node --version`.

**2. Установка зависимостей и lock-файл.** Меняет: только папку проекта.
```
npm install
```
Команда создаст `package-lock.json` с закреплённым `wrangler 4.107.1`. Сохраните этот файл вместе
с проектом. Дальше, при переустановке, используйте `npm ci` — он ставит ровно те версии, что в lock-файле.
Если npm сообщит, что версии 4.107.1 нет, установите последнюю 4.x (`npm install -D -E wrangler@4`)
и запустите тесты заново.

**3. Автотесты.** Меняет: ничего.
```
npm test
```
Ожидается `pass 40`, `fail 0`.

**4. Вход и разведка, только чтение.** Меняет: ничего.
```
npx wrangler login
npx wrangler whoami
npx wrangler deployments list --name pride-one-bot
npx wrangler secret list --name pride-one-bot
npx wrangler kv namespace list
```
Что проверить:
- `deployments list` — запишите ID текущей версии для истории.
- `secret list` — должны быть `BOT_TOKEN` и `WEBHOOK_SECRET`. Если их нет, остановитесь и напишите мне.
- `kv namespace list` — найдите `id` у namespace **PRIDE_ONE_DEMO**.

**5. ID группы Pride Test, только чтение.** Меняет: ничего.
```
npx wrangler kv key get "branch:P03" --namespace-id <ID_PRIDE_ONE_DEMO> --remote
```
Флаг `--remote` обязателен: без него Wrangler 4 читает локальное хранилище.

В ответе будет `"chatId": -100…` — это ID группы. Запишите его. Если ключа нет, включите в Telegram
Desktop «Настройки → Продвинутые настройки → Экспериментальные настройки → Show Peer IDs in Profile»
и посмотрите ID в профиле группы.

**6. Заполнить конфигурацию и файл секрета.** Меняет: только файлы проекта.

В `wrangler.jsonc` замените:
- `ВСТАВЬТЕ_ID_NAMESPACE_PRIDE_ONE_DEMO` → ID из шага 4;
- `ВСТАВЬТЕ_ID_ГРУППЫ_PRIDE_TEST` → ID из шага 5 (в кавычках, со знаком минус).

Создайте `ADMIN_SECRET` и файл для развёртывания:
```
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
```
Создайте в папке проекта файл `.secrets.deploy.env` из одной строки:
```
ADMIN_SECRET=<сгенерированное значение>
```
Сохраните значение в менеджере паролей: оно понадобится для `/admin/*`.

Не добавляйте в этот файл `BOT_TOKEN` и `WEBHOOK_SECRET` — иначе они будут заменены. Файл уже указан
в `.gitignore`.

**7. Предварительная проверка и сборка без публикации.** Меняет: ничего в Cloudflare.
```
npm run check
npm run build:dry
```
- `npm run check` — строгая проверка: конфигурация, lock-файл, версия wrangler, сборка Worker и
  Durable Object в один модуль, наличие всех RPC-методов, файл секрета. Должно быть «ошибок 0».
- `npm run build:dry` — официальная сборка Wrangler (`wrangler deploy --dry-run --outdir dist`):
  собирает и проверяет проект, ничего не публикуя. В выводе должны быть привязки `BRANCH_DO
  (BranchBookingDO)`, `PRIDE_KV`, переменная `BRANCH_CHATS`.

Можно выполнить всё сразу: `npm run verify` (тесты + check + build:dry).

---

## Развёртывание — единственный шаг, который меняет код в Cloudflare

**8. Публикация.** Меняет: код Worker, создаёт класс Durable Object, добавляет `ADMIN_SECRET`,
заменяет переменные, привязки и cron настройками из `wrangler.jsonc`.
```
npx wrangler deploy --secrets-file .secrets.deploy.env
```
- Если Wrangler предупредит, что конфигурация в Dashboard отличается от локальной, — это ожидаемо:
  ручные настройки старого Worker заменяются файлом. Прочитайте список отличий и подтвердите.
- Убедитесь, что в выводе нет ошибок и перечислены привязки `BRANCH_DO`, `PRIDE_KV`, `BRANCH_CHATS`.
- Затем удалите `.secrets.deploy.env`.

**9. Проверка после развёртывания, только чтение.** Меняет: ничего.
```
curl <URL>/health
npx wrangler secret list --name pride-one-bot
curl -H "Authorization: Bearer <ADMIN_SECRET>" "<URL>/admin/status?branch=P03"
curl -H "Authorization: Bearer <ADMIN_SECRET>" "<URL>/admin/webhook"
```
Ожидается:
- `/health` → `"version": "2.0.1"`;
- `secret list` → три секрета;
- `/admin/status` → `"schema_version": "1"` и `allowed_chat` равен ID группы;
- `/admin/webhook` → `"url_matches": true`, `last_error_message` пустой.

Если `url_matches` равно `false`, переустановите webhook (меняет только настройки Telegram):
```
curl -X POST -H "Authorization: Bearer <ADMIN_SECRET>" "<URL>/admin/webhook"
```
Во время следующих шагов держите в отдельном окне `npx wrangler tail pride-one-bot`.

---

## Перенос старых данных

**10. Пробный прогон миграции.** Меняет: ничего — транзакция откатывается. KV только читается.
```
curl -X POST -H "Authorization: Bearer <ADMIN_SECRET>" "<URL>/admin/migrate?branch=P03"
```
Проверьте отчёт:
- `verified: true`, `mismatches: []`;
- `imported_active` совпадает с числом детей, которые сейчас записаны в группе;
- `skipped` и `cancelled_reasons` — объяснимы.

**11. Миграция.** Меняет: записывает брони в SQLite Durable Object. KV не меняется.
```
curl -X POST -H "Authorization: Bearer <ADMIN_SECRET>" "<URL>/admin/migrate?branch=P03&dry_run=0"
```
Повторный запуск безопасен — вернёт `alreadyDone`. Если старая панель и общие сообщения дней были
в группе, бот отредактирует именно их, а не создаст новые.

---

## Telegram

**12. Права бота в Pride Test.** Назначьте бота администратором с правом «Удаление сообщений»: так он
убирает формы записи и ответы родителей. Без этого права всё работает, но формы остаются в чате.

**13. Панель.** Администратор отправляет в Pride Test:
```
/init P03
```
- Если панель уже есть (в том числе перенесённая из KV) — она обновится, второй не будет.
- Если её удалили — появится одна новая.
- Повторный `/init` безопасен.

**14. Проверка сценариев.** Пройдите таблицу из README, раздел 7. После каждого блока смотрите
`/admin/status`: `outbox.failed` = 0, а `outbox.pending` через несколько секунд = 0.

---

## Если что-то пошло не так

- **Аварийная остановка без потери данных.** В `wrangler.jsonc` задайте `"BRANCH_CHATS": "{}"` и
  выполните `npx wrangler deploy`. Бот перестанет работать в группе, данные в SQLite и KV сохранятся.
  Для возобновления верните ID группы и снова выполните `wrangler deploy`.
- **Откат между версиями 2.x** (после шага 8): `npx wrangler rollback`.
- **Задачи outbox в статусе `failed`:** смотрите `failed_outbox` в `/admin/status` и `wrangler tail`.
  На данные записей это не влияет.
- **Миграция вернула `verification_failed`:** ничего не записано. Пришлите отчёт — разберём расхождения.
