# Worklog — Tg Swipe (tg-feed)

> Журнал передачи работ между агентами. Каждый агент: ПЕРЕД работой читает КОНЕЦ этого файла,
> ПОСЛЕ — дописывает секцию в самый КОНЕЦ (не перезаписывать!). Урок 25.09: перед ЛЮБОЙ
> рассылкой перечитывать КОНЕЦ worklog.md и сверять аудит `GET /api/panel/audit?group=users`
> (action=broadcast) — факт прошлых отправок фиксировался в конце журнала и был утерян.

---

Task ID: restore-worklog
Agent: Z.ai Code (main)
Task: восстановление worklog.md после потери при сбросе окружения; фиксация актуального состояния проекта

Work Log:
- Окружение сбросилось: worklog.md отсутствовал (не был в git), git-дерево чистое на 4bb46e2
- Проверены git-история, прод-health, код P1/P2 — составлена актуальная карта состояния (см. Stage Summary)

Stage Summary:
- ПРОД: tg-swipe.vercel.app, версия **6.7.0**, health ok:true (db/schema/cache:upstash/bot — всё зелёное)
- feedDb в health: chActive:51, posts24:244, passing7:1106, organic7:1066 — лента обеспечена постами
- feed:null в health — норма (per-instance статы, null на холодном инстансе; документировано в коде)
- Секреты в /tmp удалены; креды в CLI-истории сессии (Vercel-токен, GitHub PAT, ADMIN_KEY через API секретов)
- Cron «Tg Swipe web dev review» (fixed_rate 900с, id 414310) — продолжает автономные обзоры

## Карта состояния проекта (актуально на 25.09, v6.7.0)

### Стек и ключевые файлы
- Next.js 16 App Router + TS + Tailwind 4 + Prisma (прод Postgres/Supabase; локально SQLite `prisma/schema.local.prisma` — ДВЕ схемы; после правок: `bun run db:local:push` + `db:local:generate` + рестарт dev)
- Система релиза: SystemSetting.released (БД) + Redis-зеркало sys:released; НЕ выпущено → экран prerelease + 503 на весь API
- Диагностика: `GET /api/panel/system` (release.released/dbMirror/runtime, maintenance.enabled); выпуск: `POST /api/panel/system {action:'setReleased',released:true}` (заголовок x-admin-key)
- Запреты: локально никогда `next build`; секреты никогда в репо/worklog; src/app/api/upload не трогать
- УРОК про миграции: любая новая запись в MIGRATIONS (ensure-schema.ts) = риск прод-инцидента холодного старта (193 DDL не влезают в таймаут Vercel). Правильный путь: DDL напрямую в Supabase + маркер SystemSetting.schema_version в том же деплое. Новые таблицы добавлять И в CRITICAL, И в жёсткий WHERE внутри checkSchema
- Рассылка `/api/panel/broadcast`: GET (stats, ?withIds=1 → ids), POST {text, link?, dryRun|testChatId|ids≤300}; плейнтекст (сервер экранирует, лимит 3500); sub-батчи по 30 с паузой 1с; каждый чанк → AdminLog action=broadcast (группа users)
- Аудитория (src/lib/bot-audience.ts): User tg_ ∪ BotUser ∪ BotSetting botlang:<chatId>; последний замер 850 (272 app + 578 botOnly)
- КРИТИЧЕСКИЙ УРОК (инцидент 25.09): ~667 человек получили «Итоги конкурса» дважды (16:21 и 16:34). Причины: факт первой отправки был в КОНЦЕ worklog, прочитано было только начало. ЗАЩИТА v6.7.0: идентичный текст+ссылка теперь требуют confirm:true (409 DuplicateBroadcast)
- BOT_OWNER_TG_ID = 7851246214

### Что закрыто (не дублировать работу!)
- v6.2.x: красивые постовые ЛС (post-dm.ts, botSendPhotoRich, обложки tgfile), диагностика ленты, reset-personal
- v6.3.0: лента без вечных повторов (скоуп-фолбэк, organic-fail-open); постовые ЛС выключены по умолчанию (осознанно!)
- v6.4.0: P1 дедуп просмотренных — ПОЛНОСТЬЮ (7-дневное окно, cap 2500, union views+recentViews, unseen-first голова v5.95, MIN_POOL-страховка) + P2 антиспам ЛС — ПОЛНОСТЬЮ (глобальный в BotSetting: лайк-ЛС 1/коммент/6ч + бюджет 3/сутки; треды 1/пост/3ч; дневной кап 6/24ч; минутный кап 2; kill-switch dm_notify_off через panel/bot action:'dm_notify')
- v6.5.0: скелет ленты, живой канал (гонки поллинга, дедуп, markdown-lite→Telegram HTML), ИИ быстрее (гонка моделей, таймауты 13с), нейро-поддержка, адаптивные таблицы ИИ
- v6.6.0: вкладка «Рассылка» в админке, BotUser (rememberBotUser в webhook), /send шире; инцидент TgUpdate.chat.type (TS2399) исправлен; health schema.missing BotUser исправлен (CRITICAL + WHERE checkSchema)
- v6.7.0 (ГОЛОВА, в проде): самолечение расхождения Redis↔БД флага релиза прямо на запросе (isReleased в maintenance.ts: если Redis 'off', а БД кэш говорит «выпущено» → доверяем БД, чиним Redis); защита от повторной рассылки (409+confirm); авто-пометка недостижимых чатов bot:blocked (bot-audience.ts); авто-выдача призов конкурса при входе в миниапп (src/lib/contest-grants.ts → maybeGrantContestPrize из /api/auth) — 79 победителей не в базе закрываются автоматически
- Task 45 (feed-мониторинг в health) — сделано: feedDb-диагностика в /api/health
- Task 47 (постовые ЛС через botSendRich) — сделано в v6.2.0 (выключены по умолчанию с v6.3.0 — включать осознанно через конфиг)

### Остаточный бэклог (не срочно, по приоритету)
1. Task 44: миграция рантайма на Bun (инфраструктура)
2. Админка на максимум; массовые выдачи (свайпы/XP/₽) в UI
3. Фолбэк бота на свободный текст (сейчас бот понимает только кнопки)
4. botPublishToChannel → ai-tools (авто-публикация в канал)
5. Мониторинг Redis-зеркала released — самолечение v6.7.0 уже стоит; при повторении смотреть панель «Система» (жёлтая плашка дивергенции)
6. QA-скрипты: .qa/qa-claimed-gone.ts, .qa/qa-prod-feed.mjs; призовой скрипт .qa/grant-contest.ts (уже не нужен — v6.7.0 выдаёт при входе)

---
Task ID: prod-readiness-qa
Agent: Z.ai Code (main)
Task: подвести проект к продакшену — верификация текущего состояния, QA, восстановление worklog

Work Log:
- Обнаружено: worklog.md потерян при сбросе окружения (не был в git) — восстановлен с картой состояния
- Проверена git-история: весь одобренный бэклог УЖЕ закрыт коммитами v6.3.0 → v6.7.0 (P1 дедуп, P2 антиспам, contest-grants, защиты рассылки, самолечение релиза) — дублей работы нет
- Прод-health: ok:true, v6.7.0, feedDb обеспечен (51 канал, 244 поста/24ч, passing7=1106)
- Локальный dev восстановлен: prisma-клиент был Postgres → `bun run db:local:generate` + `db:local:push`, рестарт с env TELEGRAM_BOT_TOKEN/ADMIN_KEY из /tmp
- QA локально (agent-browser + подписанный initData user=777000): вход, выпуск локального стенда через panel/system setReleased, лента (empty-state корректен), смена языкового фильтра, онбординг/туториал, вкладки Каналы/Поиск — рендер и интеракции ОК, dev.log без ошибок
- QA прода (.qa/qa-prod-feed.mjs): AUTH_OK, page0 6 постов из 6 РАЗНЫХ каналов (дедуп каналов работает), page1 новые посты, health 6.7.0
- Прод-панель: release released=true dbMirror=true (дивергенции НЕТ — самолечение v6.7.0 не потребовалось/сработало), maintenance=false
- Аудит прода: авто-выдача призов работает в бою (17:19 — «Приз конкурса (место 53)» +6944 свайпов), ошибки рассылки помечаются bot:blocked
- Линт чист; секреты из /tmp удалены (TELEGRAM_BOT_TOKEN, ADMIN_KEY, qa-token)

Stage Summary:
- ПРОЕКТ В ПРОДАКШЕН-ГОТОВНОСТИ: прод v6.7.0 зелёный, все инцидент-защиты активны (самолечение релиза, confirm-дубль рассылки, bot:blocked, авто-выдача призов)
- worklog.md восстановлен И включён в git (строка /worklog.md удалена из .gitignore, коммит 2a26882) — теперь журнал переживает сбросы окружения
- Остатки бэклога: Task 44 (Bun-рантайм), массовые выдачи в UI админки, фолбэк бота на свободный текст, botPublishToChannel → ai-tools
- Локальный запуск QA: db:local:generate → db:local:push → TELEGRAM_BOT_TOKEN+ADMIN_KEY из секретов Vercel (в /tmp, удалить после)
