# PRIDE ONE — Telegram Mini App

Интерфейс записи на тренировки, который открывается внутри Telegram. Фронтенд — обычные HTML/CSS/JS без фреймворков (`mini-app/src`). Сервер — существующий Worker `pride-one-bot`: те же Durable Objects и SQLite, отдельного хранилища нет.

## Как это устроено

- Статические файлы собираются в `mini-app/dist` и раздаются тем же Worker через Workers Static Assets (блок `assets` в `wrangler.jsonc`). Тот же домен `…workers.dev`, поэтому CORS не нужен, а `/webhook`, `/admin/*`, `/health`, `/api/*` по-прежнему обрабатывает код Worker.
- API: `src/miniapp.js` (проверка подписи, членство в группе, маршруты) и методы `apiSchedule / apiMyBookings / apiBook / apiCancel` в `BranchBookingDO`.
- Правила записи и отмены общие с ботом: `insertBooking`, `cancelBlockReason`, `applyCancel` в `src/branch-do.js`. Бот и Mini App используют одни и те же функции.
- Схема SQLite не менялась, миграции нет. Записи из Mini App хранятся в той же таблице `bookings` (`source = 'bot'`, `prompt_id = NULL`).

## Безопасность

- Каждый запрос несёт `Authorization: tma <initData>`. Worker проверяет подпись HMAC-SHA256 ключом, выведенным из `BOT_TOKEN`, и возраст `auth_date` (до 24 ч). ID родителя берётся только из проверенного `initData`; `user_id` в теле запроса игнорируется.
- Доступ только участникам группы филиала (`getChatMember`, кеш 5 минут в памяти). Посторонние видят пустой список филиалов.
- В расписании отдаются только имена детей и флаг «моя запись». Телефоны, ID и имена родителей не отдаются.
- `BOT_TOKEN` и `ADMIN_SECRET` во фронтенде отсутствуют.

## Локальный запуск

```bash
npm run mini:build   # собрать mini-app/dist
npm run mini:dev     # макет без Telegram: http://localhost:5173/?dev_init=mock
```

Макет (`mini-app/dev/mock-server.mjs`) имитирует API в памяти и не проверяет подпись. Он нужен только чтобы посмотреть интерфейс. Расписание в нём то же, что в конфигурации Worker.

Проверка настоящего API: `npm test` (тесты M1–M10 в `test/miniapp.test.mjs`). Полный запуск с реальным Telegram (`wrangler dev`) требует HTTPS-адреса и BotFather, поэтому делается после публикации.

## Публикация (когда будет решено)

1. `npm run mini:build`
2. `npm run verify`
3. `npx wrangler deploy`. Важно: после добавления блока `assets` любой `wrangler deploy` публикует и Mini App. Миграции Durable Object не нужны.
4. Настроить BotFather (ниже).

URL Mini App: `https://pride-one-bot.rustik-yuldashev.workers.dev/`. Корень `/` теперь отдаёт приложение, а `/health` работает как раньше.

## Настройки BotFather

- `/newapp` (выбрать бота, указать название, описание, иконку 640×360, URL Mini App) или `/setmenubutton` с URL Mini App: кнопка меню в личном чате бота.
- Для открытия из группы: инлайн-кнопка `web_app` не работает в группах, поэтому ссылка вида `https://t.me/<бот>/<короткое_имя>` (Direct Link) в закрепе группы. Выбрать вариант нужно до публикации.
- `/setdomain`: нужен только для Login Widget, для Mini App не нужен.
- Бот должен оставаться участником группы филиала (иначе `getChatMember` не сработает).

## API

Все запросы: заголовок `Authorization: tma <initData>`. Ответы JSON; ошибки `{ ok: false, code, message }`.

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/branches` | Филиалы, группы которых доступны родителю: `{ branches: [{id, name}] }` |
| GET | `/api/schedule?branch=P03` | Ближайшие 4 недели: `days[] → slots[] { time, count, open, children[] { name, mine, booking_id? } }` |
| GET | `/api/my` | Будущие записи родителя по всем доступным филиалам |
| POST | `/api/book` | `{ branch, date, time, child_name }` → `{ ok, code: booked, booking }` или отказ 409: `bad_name`, `slot_closed`, `duplicate` |
| POST | `/api/cancel` | `{ branch, booking_id }` → `cancelled` или отказ 409: `not_found`, `not_owner`, `already`, `started` |

Коды 401: нет или недействительная подпись, устаревший `initData`. 403: филиал недоступен. Новый филиал появляется в приложении автоматически после добавления в `BRANCHES` и `BRANCH_CHATS`.

## Поведение в группе

Запись из Mini App не отправляет отдельное «подтверждение» в группу (в нём кнопка отмены принадлежит чату). Общий список дня и панель обновляются, как при записи через бота. Отмена из Mini App публикует то же уведомление «Запись отменена», что и отмена через бота (2.0.2).
