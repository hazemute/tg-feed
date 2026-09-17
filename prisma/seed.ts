/**
 * TG-Feed seed: категории, каналы, посты, реклама.
 * Запуск: bun prisma/seed.ts
 */
import { PrismaClient } from '@prisma/client'
import fs from 'fs'
import path from 'path'

const db = new PrismaClient()

const mediaDir = path.join(process.cwd(), 'public', 'media')
const hasMedia = (f: string) => fs.existsSync(path.join(mediaDir, f))

const categories = [
  { slug: 'crypto', title: 'Крипта', emoji: '', order: 1 },
  { slug: 'news', title: 'Новости', emoji: '', order: 2 },
  { slug: 'it', title: 'IT и AI', emoji: '', order: 3 },
  { slug: 'humor', title: 'Юмор', emoji: '', order: 4 },
  { slug: 'business', title: 'Бизнес', emoji: '', order: 5 },
  { slug: 'travel', title: 'Путешествия', emoji: '', order: 6 },
  { slug: 'food', title: 'Еда', emoji: '', order: 7 },
  { slug: 'sport', title: 'Спорт', emoji: '', order: 8 },
  { slug: 'other', title: 'Без категории', emoji: '', order: 9 },
]

type SeedPost = { text: string; media?: string; gallery?: string[]; hoursAgo: number; likes?: number; views?: number }
type SeedChannel = {
  username: string; title: string; description: string; color: string
  category: string; premium?: boolean; subs: number; posts: SeedPost[]
}

const channels: SeedChannel[] = [
  {
    username: 'cryptokot_feed', title: 'Крипто Кот', description: 'Криптовалюты без воды: рынок, аналитика, монеты', color: '#f7931a', category: 'crypto', premium: true, subs: 48200,
    posts: [
      { text: 'Биткоин закрепился выше $97 000 и обновил локальный максимум. Ликвидации шортов за сутки — $240 млн. Кто ещё не верил — самое время пересобрать портфель 📊', media: 'crypto.png', gallery: ['market.png'], hoursAgo: 2, likes: 384, views: 18400 },
      { text: 'Госдума приняла закон о налогообложении криптоактивов: ставка для майнеров — 15%.\n\nРазбираем по пунктам, что изменится для частных инвесторов:\n1. Декларировать доходы нужно с нового года\n2. Обмен между кошельками не облагается\n3. Майнинг признают предпринимательской деятельностью\n\nПолный разбор — вечером 🧵', hoursAgo: 9, likes: 512, views: 24300 },
      { text: 'Ethereum: комиссия в сети упала до $0.8 после апгрейда. Переводы стали дешевле, чем в 2021 году, в 40 раз ⚡️', media: 'market.png', hoursAgo: 26, likes: 291, views: 15200 },
      { text: 'Топ-3 альткоина недели по притоку капитала: SOL, TON, AVAX. Полный разбор с уровнями — в вечернем посте 🌙', hoursAgo: 50, likes: 205, views: 12100 },
      { text: 'Помните: рынок наказывает жадных. Фиксируйте прибыль по частям, ставьте стопы и не заходите на весь депозит. Дисциплина важнее прогнозов 🐱', hoursAgo: 96, likes: 178, views: 9800 },
    ],
  },
  {
    username: 'coinvoice_feed', title: 'CoinVoice', description: 'Голос криптоиндустрии: новости и интервью', color: '#26a17b', category: 'crypto', subs: 21400,
    posts: [
      { text: 'USDT внедряет нативные переводы в Telegram Wallet. Комиссия — 0.1 USDT, зачисление за 3 секунды. Подробности и лимиты внутри 📩', hoursAgo: 4, likes: 154, views: 8900 },
      { text: 'SEC одобрила заявку на листинг опционов на спотовые BTC-ETF. Институциональные инвесторы продолжают заходить в рынок 🏛️', media: 'market.png', hoursAgo: 30, likes: 118, views: 7400 },
      { text: 'Аирдроп-сезон: 3 проекта с подтверждёнными дропами для активных кошельков.\n\nЧек-лист действий — как успеть без больших вложений 🪂', hoursAgo: 55, likes: 97, views: 6100 },
    ],
  },
  {
    username: 'defiradar_feed', title: 'DeFi Радар', description: 'Децентрализованные финансы: пулы, стейкинг, аналитика', color: '#6f4dbf', category: 'crypto', subs: 9800,
    posts: [
      { text: 'TVL в DeFi вернулся к $120 млрд. Лидеры роста — протоколы рестейкинга. Куда движется ликвидность — карта недели 🗺️', hoursAgo: 6, likes: 76, views: 4200 },
      { text: 'Стейблкоины: доля USDT на рынке выросла до 71%. Почему рынок снова бежит в «наличные» — разбор 💵', hoursAgo: 28, likes: 64, views: 3900 },
      { text: 'Новый дэшборд: сравнение доходности пулов по 40 протоколам. Обновляем каждый час, ссылка в закрепе 📈', hoursAgo: 78, likes: 51, views: 3100 },
    ],
  },
  {
    username: 'srochnye_feed', title: 'Срочные Новости', description: 'Главные события России и мира', color: '#e0533d', category: 'news', subs: 156300,
    posts: [
      { text: '⚡️ Курс доллара опустился ниже 92 рублей впервые за три месяца. Аналитики связывают это с притоком экспортной выручки и снижением спроса на валюту', media: 'news.png', hoursAgo: 1, likes: 642, views: 98200 },
      { text: 'Центробанк сохранил ключевую ставку на уровне 16%.\n\nЧто это значит коротко:\n— Вклады останутся доходными\n— Ипотека дешеветь не будет\n— Инфляционные ожидания под контролем 🏦', hoursAgo: 8, likes: 481, views: 76400 },
      { text: 'Открыто движение по новой трассе М-12 до Казани: время в пути из Москвы сократилось до 6 часов 🚗', hoursAgo: 22, likes: 356, views: 52100 },
      { text: 'Метеобюро обещает тёплые выходные: до +18 °C в центре европейской части страны. Планируйте прогулки ☀️', hoursAgo: 33, likes: 289, views: 44800 },
    ],
  },
  {
    username: 'newslight_feed', title: 'Новости Просто', description: 'Новости понятным языком', color: '#2b7cd3', category: 'news', subs: 63100,
    posts: [
      { text: 'Коротко к утру: 5 главных событий, которые стоит знать, пока вы пили кофе ☕️ — от новых тарифов до запуска в космос', hoursAgo: 3, likes: 244, views: 31200 },
      { text: 'Учёные вырастили «лабораторный» кофе, который невозможно отличить от колумбийского. Продажи начнутся в 2026 году 🌱', media: 'news.png', hoursAgo: 27, likes: 187, views: 24600 },
      { text: 'В трёх городах запускают беспилотные трамваи. Первый месяц — без пассажиров, только тесты на маршруте 🚋', hoursAgo: 52, likes: 142, views: 19800 },
    ],
  },
  {
    username: 'techtalk_feed', title: 'TechTalk', description: 'Технологии, гаджеты и нейросети', color: '#3390ec', category: 'it', premium: true, subs: 87500,
    posts: [
      { text: 'Apple представила M5 Ultra: 48-ядерный CPU и 96 ГБ unified memory уже в базовой комплектации.\n\nРазбираем, кому реально нужен новый Mac Studio, а кому хватит прошлогоднего 🖥️', media: 'tech.png', gallery: ['ai.png'], hoursAgo: 2, likes: 812, views: 64100 },
      { text: 'GitHub Copilot научился рефакторить целые модули и писать тесты самостоятельно. Показываем примеры промптов и где модель всё ещё ошибается 🤖', hoursAgo: 10, likes: 603, views: 48200 },
      { text: 'Обзор: 7 гаджетов, которые действительно стоит купить в 2025 году. Без маркетинга — только то, что пережило месяц тестов 🔧', media: 'tech.png', hoursAgo: 24, likes: 544, views: 39700 },
      { text: 'Кто выиграл гонку нейросетей в этом квартале: сравниваем GPT, Claude и Gemini по 12 реальным задачам — от кода до перевода юридических документов 🏁', media: 'ai.png', hoursAgo: 47, likes: 690, views: 51300 },
    ],
  },
  {
    username: 'devdigest_feed', title: 'Dev Дайджест', description: 'Дайджест для разработчиков', color: '#0f9d58', category: 'it', subs: 34900,
    posts: [
      { text: 'React 19.2: что такое Server Components на самом деле и почему без них уже никуда. Гайд для тех, кто «в проде» ⚛️', hoursAgo: 5, likes: 231, views: 17400 },
      { text: 'PostgreSQL 18 в бете: асинхронный I/O ускоряет чтение до 3 раз. Смотрим бенчмарки и план миграции 🐘', hoursAgo: 20, likes: 198, views: 14200 },
      { text: 'Зарплаты backend-разработчиков за квартал: медиана 280 000 ₽, лидеры по росту — Rust и Go. Полное исследование с графиками 💰', hoursAgo: 45, likes: 317, views: 22600 },
    ],
  },
  {
    username: 'aiwave_feed', title: 'AI Волна', description: 'Нейросети простыми словами', color: '#7c4dff', category: 'it', subs: 41200,
    posts: [
      { text: 'Нейросети научились генерировать видео в 4K за 40 секунд. Сравнили 5 моделей — результаты удивили даже скептиков 🎬', media: 'ai.png', gallery: ['tech.png'], hoursAgo: 3, likes: 389, views: 28700 },
      { text: 'Промпт-инженерия умерла? Нет — она изменилась. 12 приёмов, которые работают в 2025 году: от chain-of-thought до few-shot с примерами из домена 🧠', hoursAgo: 18, likes: 276, views: 21400 },
      { text: 'Локальная LLM на ноутбуке: инструкция, как запустить модель на 8B параметров без потери батареи и терминала 🔋', media: 'tech.png', hoursAgo: 40, likes: 224, views: 16800 },
    ],
  },
  {
    username: 'sarcasm_room', title: 'Комната Сарказма', description: 'Лучшие шутки рунета', color: '#f4511e', category: 'humor', subs: 112000,
    posts: [
      { text: 'Понедельник — это просто вторник, который слишком рано вышел из дома 🐌', media: 'humor.png', gallery: ['humor.png'], hoursAgo: 4, likes: 1892, views: 121000 },
      { text: '— Дорогой, я в магазин. — Возьми хлеб.\n— Мы же не едим хлеб.\n— Возьми хлеб. Ты идёшь в магазин, а не в МГУ 🍞', hoursAgo: 12, likes: 2404, views: 143000 },
      { text: 'Мой уровень продуктивности: поставил будильник на 6:00, чтобы успеть понажимать «отложить» до 9:00 ⏰', hoursAgo: 29, likes: 1556, views: 98700 },
    ],
  },
  {
    username: 'devhumor_feed', title: 'Айтишный Юмор', description: 'Мемы для тех, кто в IT', color: '#546e7a', category: 'humor', subs: 58400,
    posts: [
      { text: 'ТЗ на одну кнопочку: 14 страниц, 4 созвона и три месяца спринтов 🤡', media: 'humor.png', hoursAgo: 7, likes: 940, views: 62300 },
      { text: 'Сеньор на код-ревью джуна: «Интересно… А если подумать?»\nДжун (внутри): уже открывает вакансии тестировщика 🙃', hoursAgo: 25, likes: 812, views: 54100 },
      { text: '«У нас на проде всё работает» — самая страшная фраза в пятницу после обеда 🚒', hoursAgo: 49, likes: 780, views: 49800 },
    ],
  },
  {
    username: 'bizstart_feed', title: 'Стартап и Бизнес', description: 'Как строить бизнес в России', color: '#00897b', category: 'business', subs: 39800,
    posts: [
      { text: 'Как мы выросли с 0 до 10 млн выручки за 14 месяцев на подписке.\n\nЧестный разбор: цифры, ошибки, юнит-экономика и почему мы чуть не закрылись на четвёртом месяце 📊', media: 'business.png', hoursAgo: 6, likes: 420, views: 26400 },
      { text: '5 бизнес-моделей 2025 года, которые реально работают: от маркетплейс-агрегаторов до SaaS для малого бизнеса. С примерами и маржой 🧩', hoursAgo: 26, likes: 318, views: 19800 },
      { text: 'Питч инвестору за 90 секунд: структура, после которой вам перезванивают. Шаблон внутри — сохраняйте 🎯', hoursAgo: 72, likes: 264, views: 16400 },
    ],
  },
  {
    username: 'moneymind_feed', title: 'Мышление Деньги', description: 'Личные финансы и инвестиции', color: '#ef6c00', category: 'business', subs: 74600,
    posts: [
      { text: 'Личный бюджет за 10 минут в день: система конвертов, которая пережила три кризиса. Пошагово, с таблицей 🧾', media: 'market.png', gallery: ['business.png'], hoursAgo: 9, likes: 374, views: 24900 },
      { text: 'Почему ипотека под 6% — не всегда выгода: считаем полную стоимость с ремонтом, страховками и упущенной ставкой по вкладу 🏠', hoursAgo: 32, likes: 289, views: 18300 },
      { text: 'Инфляция съедает вклад? Считаем реальные ставки и где деньги действительно работают в 2025 году 📉', hoursAgo: 60, likes: 231, views: 14700 },
    ],
  },
  {
    username: 'cheaptrip_feed', title: 'Дешёвые Путешествия', description: 'Лайфхаки дешёвых перелётов', color: '#00acc1', category: 'travel', subs: 92100,
    posts: [
      { text: 'Билеты в Стамбул за 9 800 ₽ туда-обратно в ноябре. Лайфхак: распродажи ловите во вторник утром, кэшбэк — через карту оператора ✈️', media: 'travel.png', hoursAgo: 5, likes: 531, views: 34200 },
      { text: 'Грузия без виз и без денег: 7 дней на 25 000 ₽ с проживанием, винными дегустациями и походом в горы. Подробный маршрут 🍇', hoursAgo: 21, likes: 468, views: 29700 },
      { text: 'Топ-10 направлений на Новый год, где ещё остались дешёвые билеты. Успейте забронировать до декабря 🎄', hoursAgo: 44, likes: 397, views: 26400 },
    ],
  },
  {
    username: 'roadnotes_feed', title: 'Записки Дороги', description: 'Авторские маршруты и трип-репорты', color: '#8d6e63', category: 'travel', subs: 18700,
    posts: [
      { text: 'Кольский полуостров на машине: маршрут на 5 дней, где увидеть северное сияние и не разориться на бензине. Старт — Мурманск 🚙', hoursAgo: 14, likes: 164, views: 9800 },
      { text: 'Термос, плед и рассвет на Планерной: как устроить маленькое путешествие, не выезжая из города 🌅', media: 'travel.png', hoursAgo: 36, likes: 121, views: 7600 },
      { text: 'Вместо отеля — капсулы: ночевали в новом хостеле-капсулах в Питере. Честный отзыв: кто подойдёт, кому не стоит 🛏️', hoursAgo: 68, likes: 98, views: 6400 },
    ],
  },
  {
    username: 'cookfast_feed', title: 'Готовим Быстро', description: 'Рецепты на каждый день', color: '#d81b60', category: 'food', subs: 103500,
    posts: [
      { text: 'Паста качо э пепе за 12 минут: три ингредиента, ноль усилий, вкус ресторана. Главный секрет — вода, в которой варилась паста 🧀', media: 'food.png', hoursAgo: 2, likes: 1034, views: 68200 },
      { text: 'Завтрак за 5 минут: шакшука, которая спасает любое утро. Нужны яйца, томаты и одна сковорода 🍳', hoursAgo: 16, likes: 876, views: 54900 },
      { text: 'Мраморная говядина в аэрогриле: как не пересушить стейк за 8 минут. Таблица температур внутри 🥩', media: 'food.png', hoursAgo: 34, likes: 745, views: 47300 },
    ],
  },
  {
    username: 'coffeetime_feed', title: 'Кофе и Десерты', description: 'Про кофе, чай и десерты', color: '#795548', category: 'food', subs: 27300,
    posts: [
      { text: 'Как варить фильтр дома без дорогой техники: воронка, помол и 3 ошибки новичков, которые убивают вкус ☕️', hoursAgo: 11, likes: 187, views: 12400 },
      { text: 'Чизкейк без печи за 20 минут активной работы. Рецепт, который прошёл 200 тестов редакции 🍰', media: 'food.png', hoursAgo: 38, likes: 243, views: 15600 },
      { text: 'Обзор ростерий: 6 сортов зерна до 1000 ₽/кг, которые не стыдно подарить (и себе тоже) 🎁', hoursAgo: 62, likes: 165, views: 10800 },
    ],
  },
  {
    username: 'sportpulse_feed', title: 'Спорт Пульс', description: 'Главные спортивные события', color: '#2e7d32', category: 'sport', subs: 68900,
    posts: [
      { text: 'ФИНАЛ КУБКА: 3:2 в овертайме! Разбор матча по минутам, лучшие моменты и что сказали тренеры после игры ⚽️🔥', media: 'sport.png', gallery: ['sport.png'], hoursAgo: 2, likes: 943, views: 58200 },
      { text: 'Трансферное окно: топ-5 сделок, которые уже согласованы. Одна из них — настоящая сенсация 💥', hoursAgo: 13, likes: 712, views: 46900 },
      { text: 'Марафонский сезон: как выбрать первые старты, построить тренировочный план и не выгореть к осени 🏃', hoursAgo: 37, likes: 498, views: 32100 },
    ],
  },
  {
    username: 'football_review', title: 'Футбольный Обзор', description: 'Тактика, таблицы, трансферы', color: '#1565c0', category: 'sport', subs: 45200,
    posts: [
      { text: 'Таблица после 12 тура: интрига в чемпионской гонке вернулась. Отставание лидера — всего 2 очка 📊', media: 'sport.png', hoursAgo: 10, likes: 386, views: 27400 },
      { text: 'Тактический разбор: как середняк обыграл гранда прессингом в три линии. Схемы, цифры xG и ключевые эпизоды 🧠', hoursAgo: 31, likes: 324, views: 22800 },
      { text: 'Молодёжка: 4 игрока, за которыми уже следят скауты топ-клубов Европы. Смотрим их сильные стороны 🔭', hoursAgo: 58, likes: 257, views: 18600 },
    ],
  },
]

const ads = [
  {
    title: 'Крипто-сигналы PRO', body: 'Точные входы по BTC и альтам от трейдеров с 8-летним опытом. Статистика сделок открыта. Первые 7 дней — бесплатно.',
    ctaLabel: 'Подписаться', link: 'https://t.me/crypto_signals_pro',
  },
  {
    title: 'VPN для Telegram', body: 'Стабильный доступ к мессенджеру из любой точки. Серверы в 12 странах, до 3 устройств на тарифе.',
    ctaLabel: 'Подключить', link: 'https://t.me/vpn_deal_bot',
  },
  {
    title: 'Ваша реклама в TG-Feed', body: 'Этот слот видят тысячи пользователей каждый день. Прямые продажи, без посредников.',
    ctaLabel: 'Написать создателю', link: 'https://t.me/tgfeed_creator',
  },
]

async function main() {
  console.log('Seeding TG-Feed…')

  await db.like.deleteMany()
  await db.postView.deleteMany()
  await db.subscription.deleteMany()
  await db.post.deleteMany()
  await db.channel.deleteMany()
  await db.category.deleteMany()
  await db.ad.deleteMany()
  await db.user.deleteMany()

  const catIds: Record<string, string> = {}
  for (const c of categories) {
    const created = await db.category.create({ data: c })
    catIds[c.slug] = created.id
  }

  let mediaCount = 0
  for (let ci = 0; ci < channels.length; ci++) {
    const ch = channels[ci]
    const created = await db.channel.create({
      data: {
        tgId: `-1001${String(10000000 + ci)}`,
        title: ch.title,
        username: ch.username,
        description: ch.description,
        avatarColor: ch.color,
        categoryId: catIds[ch.category],
        isPremium: !!ch.premium,
        premiumUntil: ch.premium ? new Date(Date.now() + 14 * 86400e3) : null,
        status: 'active',
        subscribersCount: ch.subs,
        clicksCount: Math.round(ch.subs * 0.031),
      },
    })

    let msgNo = 100
    for (const p of ch.posts) {
      const mediaOk = p.media && hasMedia(p.media)
      if (mediaOk) mediaCount++
      const galleryItems = (p.gallery ?? []).filter((g) => hasMedia(g)).map((g) => `/media/${g}`)
      await db.post.create({
        data: {
          tgKey: `${ch.username}:${msgNo}`,
          channelId: created.id,
          text: p.text,
          mediaUrl: mediaOk ? `/media/${p.media}` : null,
          gallery: galleryItems.length > 0 ? JSON.stringify(galleryItems) : null,
          link: `https://t.me/${ch.username}/${msgNo}`,
          likesCount: p.likes ?? 200 + ((msgNo * 137) % 400),
          viewsCount: p.views ?? (p.likes ?? 200) * 47 + ((msgNo * 977) % 3000),
          publishedAt: new Date(Date.now() - p.hoursAgo * 3600e3),
        },
      })
      msgNo++
    }
  }

  for (const a of ads) await db.ad.create({ data: a })

  const postsTotal = await db.post.count()
  console.log(`Done: ${channels.length} channels, ${postsTotal} posts, ${mediaCount} with media, ${ads.length} ads`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
