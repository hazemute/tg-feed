-- ============================================================================
-- TG-Feed — сид-данные для Supabase (ПОЛНОЕ зеркало prisma/seed.ts)
-- ============================================================================
--
-- ЧТО ВНУТРИ (идентично локальной SQLite-базе, которую наполняет
-- `bun prisma/seed.ts`):
--   • 9 категорий  (emoji = ПУСТАЯ СТРОКА '' — принципиально, без эмодзи)
--   • 18 каналов   (2 премиум: Крипто Кот, TechTalk)
--   • 58 постов    (21 с mediaUrl, 6 с каруселью gallery)
--   • 3 рекламы
--
-- КОНВЕНЦИИ ID (фиксированные, читаемые):
--   категории: 'cat_<slug>'                        → cat_crypto, cat_news, ...
--   каналы:    'ch_<username без суффикса _feed>'  → ch_cryptokot, ch_coinvoice,
--                                                    ch_sarcasm_room (суффикса
--                                                    _feed нет — имя целиком),
--                                                    ch_football_review
--   посты:     'post_<username без _feed>_<N>', N = 1..k в порядке seed.ts
--   реклама:   'ad_1', 'ad_2', 'ad_3'
--
-- КАК ЗЕРКАЛИТСЯ seed.ts:
--   • tgId каналов — синтетический ЧИСЛОВОЙ (формат seed.ts):
--     '-1001' + String(10000000 + i), где i — индекс канала 0..17
--     → '-100110000000', '-100110000001', ..., '-100110000017'
--   • tgKey постов — '<username>:<msgNo>', msgNo стартует с 100 и растёт
--     на 1 с каждым постом канала (let msgNo = 100; msgNo++) →
--     'cryptokot_feed:100' … 'cryptokot_feed:104'
--   • link постов — 'https://t.me/<username>/<msgNo>' (именно так в seed.ts;
--     PostCard использует link для «Поделиться», DiscoverTab — для открытия
--     канала, поэтому NULL ломал бы паритет с локальной базой)
--   • likesCount/viewsCount — точные значения из seed.ts (fallback-формула
--     не используется: у всех постов likes и views заданы явно)
--   • clicksCount каналов = Math.round(subs * 0.031) — посчитано как в JS
--   • publishedAt = now() - interval '<hoursAgo> hours' (hoursAgo из seed.ts)
--   • premiumUntil премиум-каналов = now() + interval '14 days'
--     (seed.ts: Date.now() + 14 * 86400e3)
--   • mediaUrl — '/media/<файл>' (все 12 файлов существуют в public/media:
--     crypto.png, tech.png, news.png, humor.png, business.png, travel.png,
--     food.png, sport.png, ai.png, market.png, video_ai.mp4, video_sport.mp4 —
--     т.е. hasMedia() везде true); mediaType остаётся дефолтным 'image'
--     (видео-файлы .mp4 в сид-постах seed.ts не используются)
--   • gallery — JSON-строка '["/media/a.png",...]' (только у 6 постов)
--   • notifiedAt = NULL, aiSummary = NULL (не рассылались / не генерировались)
--
-- ИДЕМПОТЕНТНОСТЬ: повторный запуск безопасен.
--   • Category — INSERT ... ON CONFLICT (id) DO UPDATE (обновит slug/title/emoji/order)
--   • Channel / Post / Ad — INSERT ... ON CONFLICT (id) DO NOTHING
--   Предполагается СВЕЖАЯ база (после schema.sql + policies.sql); если в базе
--   уже есть каналы с теми же username/tgId, но другими id, — конфликт
--   уникальных индексов остановит сид: очистите таблицы или замените id.
--
-- ПОРЯДОК ПРИМЕНЕНИЯ: ТРЕТЬИМ (после schema.sql и policies.sql).
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Категории (9) — id 'cat_<slug>' с эмодзи
-- ---------------------------------------------------------------------------
INSERT INTO "Category" ("id", "slug", "title", "emoji", "order") VALUES
    ('cat_crypto',   'crypto',   'Крипта',         '🪙', 1),
    ('cat_news',     'news',     'Новости',        '📰', 2),
    ('cat_it',       'it',       'IT и AI',        '🤖', 3),
    ('cat_humor',    'humor',    'Юмор',           '😂', 4),
    ('cat_business', 'business', 'Бизнес',         '📈', 5),
    ('cat_travel',   'travel',   'Путешествия',    '✈️', 6),
    ('cat_food',     'food',     'Еда',            '🍕', 7),
    ('cat_sport',    'sport',    'Спорт',          '⚽', 8),
    ('cat_other',    'other',    'Без категории',  '🗂', 9)
ON CONFLICT ("id") DO UPDATE SET
    "slug"  = EXCLUDED."slug",
    "title" = EXCLUDED."title",
    "emoji" = EXCLUDED."emoji",
    "order" = EXCLUDED."order";

-- ---------------------------------------------------------------------------
-- 2. Каналы (18) — id 'ch_<username без _feed>', tgId '-1001100000NN'
-- ---------------------------------------------------------------------------
INSERT INTO "Channel" (
    "id", "tgId", "title", "username", "description", "avatarColor",
    "categoryId", "isPremium", "premiumUntil", "status",
    "subscribersCount", "clicksCount", "createdAt"
) VALUES
    -- i=0, premium: clicksCount = round(48200*0.031) = 1494
    ('ch_cryptokot', '-100110000000', 'Крипто Кот', 'cryptokot_feed',
     'Криптовалюты без воды: рынок, аналитика, монеты', '#f7931a',
     'cat_crypto', true, now() + interval '14 days', 'active', 48200, 1494, now()),
    -- i=1
    ('ch_coinvoice', '-100110000001', 'CoinVoice', 'coinvoice_feed',
     'Голос криптоиндустрии: новости и интервью', '#26a17b',
     'cat_crypto', false, NULL, 'active', 21400, 663, now()),
    -- i=2
    ('ch_defiradar', '-100110000002', 'DeFi Радар', 'defiradar_feed',
     'Децентрализованные финансы: пулы, стейкинг, аналитика', '#6f4dbf',
     'cat_crypto', false, NULL, 'active', 9800, 304, now()),
    -- i=3
    ('ch_srochnye', '-100110000003', 'Срочные Новости', 'srochnye_feed',
     'Главные события России и мира', '#e0533d',
     'cat_news', false, NULL, 'active', 156300, 4845, now()),
    -- i=4
    ('ch_newslight', '-100110000004', 'Новости Просто', 'newslight_feed',
     'Новости понятным языком', '#2b7cd3',
     'cat_news', false, NULL, 'active', 63100, 1956, now()),
    -- i=5, premium: clicksCount = round(87500*0.031) = 2713
    ('ch_techtalk', '-100110000005', 'TechTalk', 'techtalk_feed',
     'Технологии, гаджеты и нейросети', '#3390ec',
     'cat_it', true, now() + interval '14 days', 'active', 87500, 2713, now()),
    -- i=6
    ('ch_devdigest', '-100110000006', 'Dev Дайджест', 'devdigest_feed',
     'Дайджест для разработчиков', '#0f9d58',
     'cat_it', false, NULL, 'active', 34900, 1082, now()),
    -- i=7
    ('ch_aiwave', '-100110000007', 'AI Волна', 'aiwave_feed',
     'Нейросети простыми словами', '#7c4dff',
     'cat_it', false, NULL, 'active', 41200, 1277, now()),
    -- i=8 (username без суффикса _feed)
    ('ch_sarcasm_room', '-100110000008', 'Комната Сарказма', 'sarcasm_room',
     'Лучшие шутки рунета', '#f4511e',
     'cat_humor', false, NULL, 'active', 112000, 3472, now()),
    -- i=9
    ('ch_devhumor', '-100110000009', 'Айтишный Юмор', 'devhumor_feed',
     'Мемы для тех, кто в IT', '#546e7a',
     'cat_humor', false, NULL, 'active', 58400, 1810, now()),
    -- i=10
    ('ch_bizstart', '-100110000010', 'Стартап и Бизнес', 'bizstart_feed',
     'Как строить бизнес в России', '#00897b',
     'cat_business', false, NULL, 'active', 39800, 1234, now()),
    -- i=11
    ('ch_moneymind', '-100110000011', 'Мышление Деньги', 'moneymind_feed',
     'Личные финансы и инвестиции', '#ef6c00',
     'cat_business', false, NULL, 'active', 74600, 2313, now()),
    -- i=12
    ('ch_cheaptrip', '-100110000012', 'Дешёвые Путешествия', 'cheaptrip_feed',
     'Лайфхаки дешёвых перелётов', '#00acc1',
     'cat_travel', false, NULL, 'active', 92100, 2855, now()),
    -- i=13
    ('ch_roadnotes', '-100110000013', 'Записки Дороги', 'roadnotes_feed',
     'Авторские маршруты и трип-репорты', '#8d6e63',
     'cat_travel', false, NULL, 'active', 18700, 580, now()),
    -- i=14
    ('ch_cookfast', '-100110000014', 'Готовим Быстро', 'cookfast_feed',
     'Рецепты на каждый день', '#d81b60',
     'cat_food', false, NULL, 'active', 103500, 3209, now()),
    -- i=15
    ('ch_coffeetime', '-100110000015', 'Кофе и Десерты', 'coffeetime_feed',
     'Про кофе, чай и десерты', '#795548',
     'cat_food', false, NULL, 'active', 27300, 846, now()),
    -- i=16
    ('ch_sportpulse', '-100110000016', 'Спорт Пульс', 'sportpulse_feed',
     'Главные спортивные события', '#2e7d32',
     'cat_sport', false, NULL, 'active', 68900, 2136, now()),
    -- i=17 (username без суффикса _feed)
    ('ch_football_review', '-100110000017', 'Футбольный Обзор', 'football_review',
     'Тактика, таблицы, трансферы', '#1565c0',
     'cat_sport', false, NULL, 'active', 45200, 1401, now())
ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Посты (58) — id 'post_<username без _feed>_<N>', tgKey '<username>:<msgNo>',
--    msgNo с 100; mediaType остаётся 'image' (дефолт); notifiedAt/aiSummary NULL
-- ---------------------------------------------------------------------------

-- Крипто Кот (ch_cryptokot) — 5 постов
INSERT INTO "Post" ("id", "tgKey", "channelId", "text", "mediaUrl", "gallery", "link", "viewsCount", "likesCount", "publishedAt") VALUES
    ('post_cryptokot_1', 'cryptokot_feed:100', 'ch_cryptokot',
     E'Биткоин закрепился выше $97 000 и обновил локальный максимум. Ликвидации шортов за сутки — $240 млн. Кто ещё не верил — самое время пересобрать портфель 📊',
     '/media/crypto.png', '["/media/market.png"]', 'https://t.me/cryptokot_feed/100', 18400, 384, now() - interval '2 hours'),
    ('post_cryptokot_2', 'cryptokot_feed:101', 'ch_cryptokot',
     E'Госдума приняла закон о налогообложении криптоактивов: ставка для майнеров — 15%.\n\nРазбираем по пунктам, что изменится для частных инвесторов:\n1. Декларировать доходы нужно с нового года\n2. Обмен между кошельками не облагается\n3. Майнинг признают предпринимательской деятельностью\n\nПолный разбор — вечером 🧵',
     NULL, NULL, 'https://t.me/cryptokot_feed/101', 24300, 512, now() - interval '9 hours'),
    ('post_cryptokot_3', 'cryptokot_feed:102', 'ch_cryptokot',
     E'Ethereum: комиссия в сети упала до $0.8 после апгрейда. Переводы стали дешевле, чем в 2021 году, в 40 раз ⚡️',
     '/media/market.png', NULL, 'https://t.me/cryptokot_feed/102', 15200, 291, now() - interval '26 hours'),
    ('post_cryptokot_4', 'cryptokot_feed:103', 'ch_cryptokot',
     E'Топ-3 альткоина недели по притоку капитала: SOL, TON, AVAX. Полный разбор с уровнями — в вечернем посте 🌙',
     NULL, NULL, 'https://t.me/cryptokot_feed/103', 12100, 205, now() - interval '50 hours'),
    ('post_cryptokot_5', 'cryptokot_feed:104', 'ch_cryptokot',
     E'Помните: рынок наказывает жадных. Фиксируйте прибыль по частям, ставьте стопы и не заходите на весь депозит. Дисциплина важнее прогнозов 🐱',
     NULL, NULL, 'https://t.me/cryptokot_feed/104', 9800, 178, now() - interval '96 hours')
ON CONFLICT ("id") DO NOTHING;

-- CoinVoice (ch_coinvoice) — 3 поста
INSERT INTO "Post" ("id", "tgKey", "channelId", "text", "mediaUrl", "gallery", "link", "viewsCount", "likesCount", "publishedAt") VALUES
    ('post_coinvoice_1', 'coinvoice_feed:100', 'ch_coinvoice',
     E'USDT внедряет нативные переводы в Telegram Wallet. Комиссия — 0.1 USDT, зачисление за 3 секунды. Подробности и лимиты внутри 📩',
     NULL, NULL, 'https://t.me/coinvoice_feed/100', 8900, 154, now() - interval '4 hours'),
    ('post_coinvoice_2', 'coinvoice_feed:101', 'ch_coinvoice',
     E'SEC одобрила заявку на листинг опционов на спотовые BTC-ETF. Институциональные инвесторы продолжают заходить в рынок 🏛️',
     '/media/market.png', NULL, 'https://t.me/coinvoice_feed/101', 7400, 118, now() - interval '30 hours'),
    ('post_coinvoice_3', 'coinvoice_feed:102', 'ch_coinvoice',
     E'Аирдроп-сезон: 3 проекта с подтверждёнными дропами для активных кошельков.\n\nЧек-лист действий — как успеть без больших вложений 🪂',
     NULL, NULL, 'https://t.me/coinvoice_feed/102', 6100, 97, now() - interval '55 hours')
ON CONFLICT ("id") DO NOTHING;

-- DeFi Радар (ch_defiradar) — 3 поста
INSERT INTO "Post" ("id", "tgKey", "channelId", "text", "mediaUrl", "gallery", "link", "viewsCount", "likesCount", "publishedAt") VALUES
    ('post_defiradar_1', 'defiradar_feed:100', 'ch_defiradar',
     E'TVL в DeFi вернулся к $120 млрд. Лидеры роста — протоколы рестейкинга. Куда движется ликвидность — карта недели 🗺️',
     NULL, NULL, 'https://t.me/defiradar_feed/100', 4200, 76, now() - interval '6 hours'),
    ('post_defiradar_2', 'defiradar_feed:101', 'ch_defiradar',
     E'Стейблкоины: доля USDT на рынке выросла до 71%. Почему рынок снова бежит в «наличные» — разбор 💵',
     NULL, NULL, 'https://t.me/defiradar_feed/101', 3900, 64, now() - interval '28 hours'),
    ('post_defiradar_3', 'defiradar_feed:102', 'ch_defiradar',
     E'Новый дэшборд: сравнение доходности пулов по 40 протоколам. Обновляем каждый час, ссылка в закрепе 📈',
     NULL, NULL, 'https://t.me/defiradar_feed/102', 3100, 51, now() - interval '78 hours')
ON CONFLICT ("id") DO NOTHING;

-- Срочные Новости (ch_srochnye) — 4 поста
INSERT INTO "Post" ("id", "tgKey", "channelId", "text", "mediaUrl", "gallery", "link", "viewsCount", "likesCount", "publishedAt") VALUES
    ('post_srochnye_1', 'srochnye_feed:100', 'ch_srochnye',
     E'⚡️ Курс доллара опустился ниже 92 рублей впервые за три месяца. Аналитики связывают это с притоком экспортной выручки и снижением спроса на валюту',
     '/media/news.png', NULL, 'https://t.me/srochnye_feed/100', 98200, 642, now() - interval '1 hours'),
    ('post_srochnye_2', 'srochnye_feed:101', 'ch_srochnye',
     E'Центробанк сохранил ключевую ставку на уровне 16%.\n\nЧто это значит коротко:\n— Вклады останутся доходными\n— Ипотека дешеветь не будет\n— Инфляционные ожидания под контролем 🏦',
     NULL, NULL, 'https://t.me/srochnye_feed/101', 76400, 481, now() - interval '8 hours'),
    ('post_srochnye_3', 'srochnye_feed:102', 'ch_srochnye',
     E'Открыто движение по новой трассе М-12 до Казани: время в пути из Москвы сократилось до 6 часов 🚗',
     NULL, NULL, 'https://t.me/srochnye_feed/102', 52100, 356, now() - interval '22 hours'),
    ('post_srochnye_4', 'srochnye_feed:103', 'ch_srochnye',
     E'Метеобюро обещает тёплые выходные: до +18 °C в центре европейской части страны. Планируйте прогулки ☀️',
     NULL, NULL, 'https://t.me/srochnye_feed/103', 44800, 289, now() - interval '33 hours')
ON CONFLICT ("id") DO NOTHING;

-- Новости Просто (ch_newslight) — 3 поста
INSERT INTO "Post" ("id", "tgKey", "channelId", "text", "mediaUrl", "gallery", "link", "viewsCount", "likesCount", "publishedAt") VALUES
    ('post_newslight_1', 'newslight_feed:100', 'ch_newslight',
     E'Коротко к утру: 5 главных событий, которые стоит знать, пока вы пили кофе ☕️ — от новых тарифов до запуска в космос',
     NULL, NULL, 'https://t.me/newslight_feed/100', 31200, 244, now() - interval '3 hours'),
    ('post_newslight_2', 'newslight_feed:101', 'ch_newslight',
     E'Учёные вырастили «лабораторный» кофе, который невозможно отличить от колумбийского. Продажи начнутся в 2026 году 🌱',
     '/media/news.png', NULL, 'https://t.me/newslight_feed/101', 24600, 187, now() - interval '27 hours'),
    ('post_newslight_3', 'newslight_feed:102', 'ch_newslight',
     E'В трёх городах запускают беспилотные трамваи. Первый месяц — без пассажиров, только тесты на маршруте 🚋',
     NULL, NULL, 'https://t.me/newslight_feed/102', 19800, 142, now() - interval '52 hours')
ON CONFLICT ("id") DO NOTHING;

-- TechTalk (ch_techtalk) — 4 поста
INSERT INTO "Post" ("id", "tgKey", "channelId", "text", "mediaUrl", "gallery", "link", "viewsCount", "likesCount", "publishedAt") VALUES
    ('post_techtalk_1', 'techtalk_feed:100', 'ch_techtalk',
     E'Apple представила M5 Ultra: 48-ядерный CPU и 96 ГБ unified memory уже в базовой комплектации.\n\nРазбираем, кому реально нужен новый Mac Studio, а кому хватит прошлогоднего 🖥️',
     '/media/tech.png', '["/media/ai.png"]', 'https://t.me/techtalk_feed/100', 64100, 812, now() - interval '2 hours'),
    ('post_techtalk_2', 'techtalk_feed:101', 'ch_techtalk',
     E'GitHub Copilot научился рефакторить целые модули и писать тесты самостоятельно. Показываем примеры промптов и где модель всё ещё ошибается 🤖',
     NULL, NULL, 'https://t.me/techtalk_feed/101', 48200, 603, now() - interval '10 hours'),
    ('post_techtalk_3', 'techtalk_feed:102', 'ch_techtalk',
     E'Обзор: 7 гаджетов, которые действительно стоит купить в 2025 году. Без маркетинга — только то, что пережило месяц тестов 🔧',
     '/media/tech.png', NULL, 'https://t.me/techtalk_feed/102', 39700, 544, now() - interval '24 hours'),
    ('post_techtalk_4', 'techtalk_feed:103', 'ch_techtalk',
     E'Кто выиграл гонку нейросетей в этом квартале: сравниваем GPT, Claude и Gemini по 12 реальным задачам — от кода до перевода юридических документов 🏁',
     '/media/ai.png', NULL, 'https://t.me/techtalk_feed/103', 51300, 690, now() - interval '47 hours')
ON CONFLICT ("id") DO NOTHING;

-- Dev Дайджест (ch_devdigest) — 3 поста
INSERT INTO "Post" ("id", "tgKey", "channelId", "text", "mediaUrl", "gallery", "link", "viewsCount", "likesCount", "publishedAt") VALUES
    ('post_devdigest_1', 'devdigest_feed:100', 'ch_devdigest',
     E'React 19.2: что такое Server Components на самом деле и почему без них уже никуда. Гайд для тех, кто «в проде» ⚛️',
     NULL, NULL, 'https://t.me/devdigest_feed/100', 17400, 231, now() - interval '5 hours'),
    ('post_devdigest_2', 'devdigest_feed:101', 'ch_devdigest',
     E'PostgreSQL 18 в бете: асинхронный I/O ускоряет чтение до 3 раз. Смотрим бенчмарки и план миграции 🐘',
     NULL, NULL, 'https://t.me/devdigest_feed/101', 14200, 198, now() - interval '20 hours'),
    ('post_devdigest_3', 'devdigest_feed:102', 'ch_devdigest',
     E'Зарплаты backend-разработчиков за квартал: медиана 280 000 ₽, лидеры по росту — Rust и Go. Полное исследование с графиками 💰',
     NULL, NULL, 'https://t.me/devdigest_feed/102', 22600, 317, now() - interval '45 hours')
ON CONFLICT ("id") DO NOTHING;

-- AI Волна (ch_aiwave) — 3 поста
INSERT INTO "Post" ("id", "tgKey", "channelId", "text", "mediaUrl", "gallery", "link", "viewsCount", "likesCount", "publishedAt") VALUES
    ('post_aiwave_1', 'aiwave_feed:100', 'ch_aiwave',
     E'Нейросети научились генерировать видео в 4K за 40 секунд. Сравнили 5 моделей — результаты удивили даже скептиков 🎬',
     '/media/ai.png', '["/media/tech.png"]', 'https://t.me/aiwave_feed/100', 28700, 389, now() - interval '3 hours'),
    ('post_aiwave_2', 'aiwave_feed:101', 'ch_aiwave',
     E'Промпт-инженерия умерла? Нет — она изменилась. 12 приёмов, которые работают в 2025 году: от chain-of-thought до few-shot с примерами из домена 🧠',
     NULL, NULL, 'https://t.me/aiwave_feed/101', 21400, 276, now() - interval '18 hours'),
    ('post_aiwave_3', 'aiwave_feed:102', 'ch_aiwave',
     E'Локальная LLM на ноутбуке: инструкция, как запустить модель на 8B параметров без потери батареи и терминала 🔋',
     '/media/tech.png', NULL, 'https://t.me/aiwave_feed/102', 16800, 224, now() - interval '40 hours')
ON CONFLICT ("id") DO NOTHING;

-- Комната Сарказма (ch_sarcasm_room) — 3 поста
INSERT INTO "Post" ("id", "tgKey", "channelId", "text", "mediaUrl", "gallery", "link", "viewsCount", "likesCount", "publishedAt") VALUES
    ('post_sarcasm_room_1', 'sarcasm_room:100', 'ch_sarcasm_room',
     E'Понедельник — это просто вторник, который слишком рано вышел из дома 🐌',
     '/media/humor.png', '["/media/humor.png"]', 'https://t.me/sarcasm_room/100', 121000, 1892, now() - interval '4 hours'),
    ('post_sarcasm_room_2', 'sarcasm_room:101', 'ch_sarcasm_room',
     E'— Дорогой, я в магазин. — Возьми хлеб.\n— Мы же не едим хлеб.\n— Возьми хлеб. Ты идёшь в магазин, а не в МГУ 🍞',
     NULL, NULL, 'https://t.me/sarcasm_room/101', 143000, 2404, now() - interval '12 hours'),
    ('post_sarcasm_room_3', 'sarcasm_room:102', 'ch_sarcasm_room',
     E'Мой уровень продуктивности: поставил будильник на 6:00, чтобы успеть понажимать «отложить» до 9:00 ⏰',
     NULL, NULL, 'https://t.me/sarcasm_room/102', 98700, 1556, now() - interval '29 hours')
ON CONFLICT ("id") DO NOTHING;

-- Айтишный Юмор (ch_devhumor) — 3 поста
INSERT INTO "Post" ("id", "tgKey", "channelId", "text", "mediaUrl", "gallery", "link", "viewsCount", "likesCount", "publishedAt") VALUES
    ('post_devhumor_1', 'devhumor_feed:100', 'ch_devhumor',
     E'ТЗ на одну кнопочку: 14 страниц, 4 созвона и три месяца спринтов 🤡',
     '/media/humor.png', NULL, 'https://t.me/devhumor_feed/100', 62300, 940, now() - interval '7 hours'),
    ('post_devhumor_2', 'devhumor_feed:101', 'ch_devhumor',
     E'Сеньор на код-ревью джуна: «Интересно… А если подумать?»\nДжун (внутри): уже открывает вакансии тестировщика 🙃',
     NULL, NULL, 'https://t.me/devhumor_feed/101', 54100, 812, now() - interval '25 hours'),
    ('post_devhumor_3', 'devhumor_feed:102', 'ch_devhumor',
     E'«У нас на проде всё работает» — самая страшная фраза в пятницу после обеда 🚒',
     NULL, NULL, 'https://t.me/devhumor_feed/102', 49800, 780, now() - interval '49 hours')
ON CONFLICT ("id") DO NOTHING;

-- Стартап и Бизнес (ch_bizstart) — 3 поста
INSERT INTO "Post" ("id", "tgKey", "channelId", "text", "mediaUrl", "gallery", "link", "viewsCount", "likesCount", "publishedAt") VALUES
    ('post_bizstart_1', 'bizstart_feed:100', 'ch_bizstart',
     E'Как мы выросли с 0 до 10 млн выручки за 14 месяцев на подписке.\n\nЧестный разбор: цифры, ошибки, юнит-экономика и почему мы чуть не закрылись на четвёртом месяце 📊',
     '/media/business.png', NULL, 'https://t.me/bizstart_feed/100', 26400, 420, now() - interval '6 hours'),
    ('post_bizstart_2', 'bizstart_feed:101', 'ch_bizstart',
     E'5 бизнес-моделей 2025 года, которые реально работают: от маркетплейс-агрегаторов до SaaS для малого бизнеса. С примерами и маржой 🧩',
     NULL, NULL, 'https://t.me/bizstart_feed/101', 19800, 318, now() - interval '26 hours'),
    ('post_bizstart_3', 'bizstart_feed:102', 'ch_bizstart',
     E'Питч инвестору за 90 секунд: структура, после которой вам перезванивают. Шаблон внутри — сохраняйте 🎯',
     NULL, NULL, 'https://t.me/bizstart_feed/102', 16400, 264, now() - interval '72 hours')
ON CONFLICT ("id") DO NOTHING;

-- Мышление Деньги (ch_moneymind) — 3 поста
INSERT INTO "Post" ("id", "tgKey", "channelId", "text", "mediaUrl", "gallery", "link", "viewsCount", "likesCount", "publishedAt") VALUES
    ('post_moneymind_1', 'moneymind_feed:100', 'ch_moneymind',
     E'Личный бюджет за 10 минут в день: система конвертов, которая пережила три кризиса. Пошагово, с таблицей 🧾',
     '/media/market.png', '["/media/business.png"]', 'https://t.me/moneymind_feed/100', 24900, 374, now() - interval '9 hours'),
    ('post_moneymind_2', 'moneymind_feed:101', 'ch_moneymind',
     E'Почему ипотека под 6% — не всегда выгода: считаем полную стоимость с ремонтом, страховками и упущенной ставкой по вкладу 🏠',
     NULL, NULL, 'https://t.me/moneymind_feed/101', 18300, 289, now() - interval '32 hours'),
    ('post_moneymind_3', 'moneymind_feed:102', 'ch_moneymind',
     E'Инфляция съедает вклад? Считаем реальные ставки и где деньги действительно работают в 2025 году 📉',
     NULL, NULL, 'https://t.me/moneymind_feed/102', 14700, 231, now() - interval '60 hours')
ON CONFLICT ("id") DO NOTHING;

-- Дешёвые Путешествия (ch_cheaptrip) — 3 поста
INSERT INTO "Post" ("id", "tgKey", "channelId", "text", "mediaUrl", "gallery", "link", "viewsCount", "likesCount", "publishedAt") VALUES
    ('post_cheaptrip_1', 'cheaptrip_feed:100', 'ch_cheaptrip',
     E'Билеты в Стамбул за 9 800 ₽ туда-обратно в ноябре. Лайфхак: распродажи ловите во вторник утром, кэшбэк — через карту оператора ✈️',
     '/media/travel.png', NULL, 'https://t.me/cheaptrip_feed/100', 34200, 531, now() - interval '5 hours'),
    ('post_cheaptrip_2', 'cheaptrip_feed:101', 'ch_cheaptrip',
     E'Грузия без виз и без денег: 7 дней на 25 000 ₽ с проживанием, винными дегустациями и походом в горы. Подробный маршрут 🍇',
     NULL, NULL, 'https://t.me/cheaptrip_feed/101', 29700, 468, now() - interval '21 hours'),
    ('post_cheaptrip_3', 'cheaptrip_feed:102', 'ch_cheaptrip',
     E'Топ-10 направлений на Новый год, где ещё остались дешёвые билеты. Успейте забронировать до декабря 🎄',
     NULL, NULL, 'https://t.me/cheaptrip_feed/102', 26400, 397, now() - interval '44 hours')
ON CONFLICT ("id") DO NOTHING;

-- Записки Дороги (ch_roadnotes) — 3 поста
INSERT INTO "Post" ("id", "tgKey", "channelId", "text", "mediaUrl", "gallery", "link", "viewsCount", "likesCount", "publishedAt") VALUES
    ('post_roadnotes_1', 'roadnotes_feed:100', 'ch_roadnotes',
     E'Кольский полуостров на машине: маршрут на 5 дней, где увидеть северное сияние и не разориться на бензине. Старт — Мурманск 🚙',
     NULL, NULL, 'https://t.me/roadnotes_feed/100', 9800, 164, now() - interval '14 hours'),
    ('post_roadnotes_2', 'roadnotes_feed:101', 'ch_roadnotes',
     E'Термос, плед и рассвет на Планерной: как устроить маленькое путешествие, не выезжая из города 🌅',
     '/media/travel.png', NULL, 'https://t.me/roadnotes_feed/101', 7600, 121, now() - interval '36 hours'),
    ('post_roadnotes_3', 'roadnotes_feed:102', 'ch_roadnotes',
     E'Вместо отеля — капсулы: ночевали в новом хостеле-капсулах в Питере. Честный отзыв: кто подойдёт, кому не стоит 🛏️',
     NULL, NULL, 'https://t.me/roadnotes_feed/102', 6400, 98, now() - interval '68 hours')
ON CONFLICT ("id") DO NOTHING;

-- Готовим Быстро (ch_cookfast) — 3 поста
INSERT INTO "Post" ("id", "tgKey", "channelId", "text", "mediaUrl", "gallery", "link", "viewsCount", "likesCount", "publishedAt") VALUES
    ('post_cookfast_1', 'cookfast_feed:100', 'ch_cookfast',
     E'Паста качо э пепе за 12 минут: три ингредиента, ноль усилий, вкус ресторана. Главный секрет — вода, в которой варилась паста 🧀',
     '/media/food.png', NULL, 'https://t.me/cookfast_feed/100', 68200, 1034, now() - interval '2 hours'),
    ('post_cookfast_2', 'cookfast_feed:101', 'ch_cookfast',
     E'Завтрак за 5 минут: шакшука, которая спасает любое утро. Нужны яйца, томаты и одна сковорода 🍳',
     NULL, NULL, 'https://t.me/cookfast_feed/101', 54900, 876, now() - interval '16 hours'),
    ('post_cookfast_3', 'cookfast_feed:102', 'ch_cookfast',
     E'Мраморная говядина в аэрогриле: как не пересушить стейк за 8 минут. Таблица температур внутри 🥩',
     '/media/food.png', NULL, 'https://t.me/cookfast_feed/102', 47300, 745, now() - interval '34 hours')
ON CONFLICT ("id") DO NOTHING;

-- Кофе и Десерты (ch_coffeetime) — 3 поста
INSERT INTO "Post" ("id", "tgKey", "channelId", "text", "mediaUrl", "gallery", "link", "viewsCount", "likesCount", "publishedAt") VALUES
    ('post_coffeetime_1', 'coffeetime_feed:100', 'ch_coffeetime',
     E'Как варить фильтр дома без дорогой техники: воронка, помол и 3 ошибки новичков, которые убивают вкус ☕️',
     NULL, NULL, 'https://t.me/coffeetime_feed/100', 12400, 187, now() - interval '11 hours'),
    ('post_coffeetime_2', 'coffeetime_feed:101', 'ch_coffeetime',
     E'Чизкейк без печи за 20 минут активной работы. Рецепт, который прошёл 200 тестов редакции 🍰',
     '/media/food.png', NULL, 'https://t.me/coffeetime_feed/101', 15600, 243, now() - interval '38 hours'),
    ('post_coffeetime_3', 'coffeetime_feed:102', 'ch_coffeetime',
     E'Обзор ростерий: 6 сортов зерна до 1000 ₽/кг, которые не стыдно подарить (и себе тоже) 🎁',
     NULL, NULL, 'https://t.me/coffeetime_feed/102', 10800, 165, now() - interval '62 hours')
ON CONFLICT ("id") DO NOTHING;

-- Спорт Пульс (ch_sportpulse) — 3 поста
INSERT INTO "Post" ("id", "tgKey", "channelId", "text", "mediaUrl", "gallery", "link", "viewsCount", "likesCount", "publishedAt") VALUES
    ('post_sportpulse_1', 'sportpulse_feed:100', 'ch_sportpulse',
     E'ФИНАЛ КУБКА: 3:2 в овертайме! Разбор матча по минутам, лучшие моменты и что сказали тренеры после игры ⚽️🔥',
     '/media/sport.png', '["/media/sport.png"]', 'https://t.me/sportpulse_feed/100', 58200, 943, now() - interval '2 hours'),
    ('post_sportpulse_2', 'sportpulse_feed:101', 'ch_sportpulse',
     E'Трансферное окно: топ-5 сделок, которые уже согласованы. Одна из них — настоящая сенсация 💥',
     NULL, NULL, 'https://t.me/sportpulse_feed/101', 46900, 712, now() - interval '13 hours'),
    ('post_sportpulse_3', 'sportpulse_feed:102', 'ch_sportpulse',
     E'Марафонский сезон: как выбрать первые старты, построить тренировочный план и не выгореть к осени 🏃',
     NULL, NULL, 'https://t.me/sportpulse_feed/102', 32100, 498, now() - interval '37 hours')
ON CONFLICT ("id") DO NOTHING;

-- Футбольный Обзор (ch_football_review) — 3 поста
INSERT INTO "Post" ("id", "tgKey", "channelId", "text", "mediaUrl", "gallery", "link", "viewsCount", "likesCount", "publishedAt") VALUES
    ('post_football_review_1', 'football_review:100', 'ch_football_review',
     E'Таблица после 12 тура: интрига в чемпионской гонке вернулась. Отставание лидера — всего 2 очка 📊',
     '/media/sport.png', NULL, 'https://t.me/football_review/100', 27400, 386, now() - interval '10 hours'),
    ('post_football_review_2', 'football_review:101', 'ch_football_review',
     E'Тактический разбор: как середняк обыграл гранда прессингом в три линии. Схемы, цифры xG и ключевые эпизоды 🧠',
     NULL, NULL, 'https://t.me/football_review/101', 22800, 324, now() - interval '31 hours'),
    ('post_football_review_3', 'football_review:102', 'ch_football_review',
     E'Молодёжка: 4 игрока, за которыми уже следят скауты топ-клубов Европы. Смотрим их сильные стороны 🔭',
     NULL, NULL, 'https://t.me/football_review/102', 18600, 257, now() - interval '58 hours')
ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Реклама (3 записи) — imageUrl NULL (дефолт), isActive true (дефолт),
--    createdAt CURRENT_TIMESTAMP (дефолт)
-- ---------------------------------------------------------------------------
INSERT INTO "Ad" ("id", "title", "body", "ctaLabel", "link") VALUES
    ('ad_1', 'Крипто-сигналы PRO',
     'Точные входы по BTC и альтам от трейдеров с 8-летним опытом. Статистика сделок открыта. Первые 7 дней — бесплатно.',
     'Подписаться', 'https://t.me/crypto_signals_pro'),
    ('ad_2', 'VPN для Telegram',
     'Стабильный доступ к мессенджеру из любой точки. Серверы в 12 странах, до 3 устройств на тарифе.',
     'Подключить', 'https://t.me/vpn_deal_bot'),
    ('ad_3', 'Ваша реклама в TG-Feed',
     'Этот слот видят тысячи пользователей каждый день. Прямые продажи, без посредников.',
     'Написать создателю', 'https://t.me/tgfeed_creator')
ON CONFLICT ("id") DO NOTHING;

COMMIT;

-- ============================================================================
-- КОНТРОЛЬ ПОСЛЕ ЗАПОЛНЕНИЯ (раскомментируйте при желании):
--
-- SELECT 'categories' AS what, count(*) FROM "Category"
-- UNION ALL SELECT 'channels', count(*) FROM "Channel"
-- UNION ALL SELECT 'posts',    count(*) FROM "Post"
-- UNION ALL SELECT 'ads',      count(*) FROM "Ad";
-- Ожидается: categories = 9, channels = 18, posts = 58, ads = 3.
--
-- Посты с медиа (ожидается 21):
-- SELECT count(*) FROM "Post" WHERE "mediaUrl" IS NOT NULL;
-- Посты с каруселью (ожидается 6):
-- SELECT count(*) FROM "Post" WHERE "gallery" IS NOT NULL;
-- ============================================================================

-- v5.5: галочки официальных каналов (курированный список)
-- UPDATE "Channel" SET "verified" = true WHERE "username" IN ('mash','lenta_ru','by_mts','rian_ru','tass_agency','interfax_news','proglib','habr_com','ostorozhno_novosti','whale_alert','lentachold','tproger_channels','championat','fparf','vedomosti','durov','rbc_news','rusnews');
