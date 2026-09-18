/**
 * TG-Feed — расширение сид-данных (Task 14-b).
 * Добавляет каналы и посты, НЕ трогая существующие данные (upsert по username/tgKey).
 * Запуск: bun scripts/seed-more.ts  (или bunx tsx scripts/seed-more.ts)
 */
import { PrismaClient } from '@prisma/client'
import fs from 'fs'
import path from 'path'

const db = new PrismaClient()

// ---------- Утилиты ----------

const mediaDir = path.join(process.cwd(), 'public', 'media')
const hasMedia = (f: string) => fs.existsSync(path.join(mediaDir, f))

/** Детерминированный PRNG (mulberry32): повторный запуск даёт те же числа. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Ретрай на транзиентные ошибки SQLite (параллельные db:push / блокировки). */
async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 4): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[retry ${i + 1}/${attempts}] ${label}: ${msg}`)
      await new Promise((r) => setTimeout(r, 400 * (i + 1)))
    }
  }
  throw lastErr
}

// ---------- Типы сид-данных ----------

type SeedPost = { n: number; text: string; media?: string; hoursAgo: number }
type SeedChannel = {
  username: string
  title: string
  description: string
  color: string
  category: string // slug
  premium?: boolean
  subs: number
  posts: SeedPost[]
}

// ---------- Новые каналы (2 на категорию; берутся первые N по мере необходимости) ----------

const NEW_CHANNELS: SeedChannel[] = [
  // ---- crypto (в БД 3 канала → добавим 1) ----
  {
    username: 'cryptomap_feed', title: 'Крипто Карта', description: 'Карта крипторынка: потоки капитала, тренды и уровни',
    color: '#26a17b', category: 'crypto', premium: true, subs: 32400,
    posts: [
      { n: 1, text: 'Солана вытянула 12% за сутки на новостях о новом раунде финансирования экосистемы. Объёмы выросли втрое, импульс пока держится. Ключевое сопротивление — $245. #крипта #солана #трейдинг', media: 'crypto.png', hoursAgo: 3 },
      { n: 2, text: 'Ончейн-метрики недели: приток в BTC-ETF составил $840 млн — крупнейший за последний месяц. Институционалы снова набирают позиции, несмотря на локальную коррекцию. #биткоин #ETF #ончейн', hoursAgo: 14 },
      { n: 3, text: 'Разбор: почему TON-экосистема растёт быстрее рынка — мемы, стейкинг и комиссии ниже цента. Показываем, где смотреть свежие проекты до листингов. #TON #альткоины', media: 'market.png', hoursAgo: 35 },
      { n: 4, text: 'Фандинг на фьючерсах уходит в минус — рынок перегрет шортами. Исторически такие моменты часто предшествуют короткому сквизу. Не торгуйте против статистики вслепую. #фьючерсы #аналитика', hoursAgo: 58 },
    ],
  },
  // ---- news (2 канала → +2) ----
  {
    username: 'newswatch_feed', title: 'Новостной Дозор', description: 'Круглосуточный мониторинг событий России и мира',
    color: '#e0533d', category: 'news', premium: false, subs: 118700,
    posts: [
      { n: 1, text: 'Правительство утвердило новый размер прожиточного минимума: с нового года он вырастет на 7,5%. Индексация коснётся пенсий и социальных выплат. #экономика #Россия', media: 'news.png', hoursAgo: 1.5 },
      { n: 2, text: 'Синоптики предупреждают о резком похолодании в Москве к концу недели: ночью до −6 °C. Коммунальные службы переведены в режим повышенной готовности. #погода', hoursAgo: 12 },
      { n: 3, text: 'Коротко за ночь: переговоры по энергоконтракту продолжаются, индекс Мосбиржи открылся ростом, в трёх регионах ввели режим ЧС из-за ледяного дождя. #события', media: 'news.png', hoursAgo: 29 },
      { n: 4, text: 'Мосбиржа: курс юаня обновил минимум за полгода. Эксперты связывают это с ростом товарооборота и переходом расчётов в нацвалюты. #валюта #биржа', hoursAgo: 54 },
    ],
  },
  {
    username: 'newsfront_feed', title: 'Главное Сейчас', description: 'Только проверенные новости, без фейков и кликбейта',
    color: '#2b7cd3', category: 'news', premium: true, subs: 74300,
    posts: [
      { n: 1, text: 'В пяти городах запускают эксперимент по бесплатному проезду в электричках по выходным. Первые итоги подведут через три месяца. #транспорт #города', media: 'news.png', hoursAgo: 5 },
      { n: 2, text: 'Минцифры: со следующего года госуслуги онлайн станут доступны по биометрии без ввода кодов. Разбираем, как это будет работать и что с безопасностью данных. #технологии #госуслуги', hoursAgo: 19 },
      { n: 3, text: 'Крупнейший логистический оператор инвестирует 12 млрд рублей в сортировочный хаб под Казанью. Это 800 новых рабочих мест и минус сутки на доставку в регионе. #бизнес #инвестиции', hoursAgo: 41 },
      { n: 4, text: 'Экологическая акция года: более 2 млн человек вышли на уборку парков по всей стране. В Москве очистили 14 гектаров ВДНХ. #общество', hoursAgo: 66 },
    ],
  },
  // ---- it (3 канала → +1) ----
  {
    username: 'itinsider_feed', title: 'Айти Инсайд', description: 'Внутренняя кухня IT: вакансии, стек и слухи из офисов',
    color: '#3390ec', category: 'it', premium: false, subs: 27800,
    posts: [
      { n: 1, text: 'Собрали статистику по 400 вакансиям за месяц: 62% требуют опыта с облачами, 48% — знание Docker, и лишь каждый пятый работодатель готов взять джуна удалённо. #вакансии #IT', hoursAgo: 4 },
      { n: 2, text: 'Docker Compose вышел в мажор: смотрим, что изменилось в синтаксисе и почему старые YAML-файлы продолжают работать. Короткий гайд по миграции. #devops', media: 'tech.png', hoursAgo: 17 },
      { n: 3, text: 'История одного рефакторинга: как легаси-монстр на 200 тысяч строк превратили в микросервисы за полгода без остановки продакшена. Честно про грабли. #разработка #легаси', hoursAgo: 39 },
      { n: 4, text: 'Тест: справитесь ли вы с вопросами с реального собеседования в продуктовую компанию? Семь задач по алгоритмам — разбор в комментариях. #собеседование', hoursAgo: 63 },
    ],
  },
  // ---- humor (2 канала → +2) ----
  {
    username: 'humorbaza_feed', title: 'Юмор База', description: 'Свежие мемы и шутки каждый час',
    color: '#f4511e', category: 'humor', premium: true, subs: 96400,
    posts: [
      { n: 1, text: 'Мой банк: ваша карта заблокирована. Я: почему? Банк: это вопрос, который вы зададите в поддержку. Поддержка: почему вы задали этот вопрос? 🤡 #мемы', media: 'humor.png', hoursAgo: 2 },
      { n: 2, text: 'Дедлайн сегодня. Я вчера: спокойно смотрел третий сезон сериала, потому что «ещё успеется». Я сейчас: пишу отчёт со скоростью мысли и опечатками. #дедлайн', hoursAgo: 15 },
      { n: 3, text: 'Учитель: где твоё домашнее задание? Я: его нет. Учитель: почему? Я: вы сказали принести своё видение проекта. Оно у меня внутри. #школа #юмор', media: 'humor.png', hoursAgo: 31 },
      { n: 4, text: 'Пятница, 18:59. Руководитель: «зайди на минутку». Через час: «небольшая правка». Правка: переписать квартальный отчёт. #работа', hoursAgo: 57 },
    ],
  },
  {
    username: 'humorpoint_feed', title: 'Точка Юмора', description: 'Смешные истории из жизни подписчиков',
    color: '#546e7a', category: 'humor', premium: false, subs: 41200,
    posts: [
      { n: 1, text: 'Купил «умные» часы, чтобы больше двигаться. Главное новое умение: красиво игнорировать уведомление о 10 000 шагов в 23:47. #жизнь #юмор', hoursAgo: 8 },
      { n: 2, text: 'Мама спросила, чем я занимаюсь на работе. Объяснял два часа. Итог: «понятно, значит, компьютерщик». Это самое точное описание моей профессии. #семья', media: 'humor.png', hoursAgo: 22 },
      { n: 3, text: 'Заказал в кафе блюдо «острое как огонь». Принесли нечто, после чего я понял: огонь бывает разный. Слёзы — тоже. #еда #истории', hoursAgo: 44 },
      { n: 4, text: 'Собеседование: назовите вашу слабую сторону. Я: честность. HR: не думаю, что это слабость. Я: мне безразлично, что вы думаете. #работа #юмор', media: 'humor.png', hoursAgo: 69 },
    ],
  },
  // ---- business (2 канала → +2) ----
  {
    username: 'businesscase_feed', title: 'Бизнес Кейсы', description: 'Реальные кейсы предпринимателей с цифрами',
    color: '#00897b', category: 'business', premium: true, subs: 56800,
    posts: [
      { n: 1, text: 'Кейс: кофейня у метро за 1,8 млн рублей. Точка вышла в плюс на пятый месяц. Считаем вместе: аренда 120к, два бариста по 65к, зерно — 9% выручки. Полная таблица юнит-экономики в посте. #бизнес #кейс', media: 'business.png', hoursAgo: 7 },
      { n: 2, text: 'Почему 70% селлеров маркетплейсов уходят в минус на второй год: три фатальные ошибки — ставка на один товар, игнор возвратов и закупка партии без теста спроса. #маркетплейсы', hoursAgo: 21 },
      { n: 3, text: 'Интервью с основателем доставки цветов: с нуля до 4 млн ₽ в месяц за два года. Про дропшиппинг, сезонность 8 марта и почему он уволил половину менеджеров. #стартап', media: 'business.png', hoursAgo: 43 },
      { n: 4, text: 'Как оформить самозанятость и не попасть на штрафы: пошаговая инструкция. Налог 4–6%, без кассы до 2 млн оборота. Сохраняйте в закладки. #самозанятость', hoursAgo: 67 },
    ],
  },
  {
    username: 'businessflow_feed', title: 'Бизнес Поток', description: 'Процессы, управление и деньги в малом бизнесе',
    color: '#ef6c00', category: 'business', premium: false, subs: 22500,
    posts: [
      { n: 1, text: 'Система OKR для команды из пяти человек: зачем она нужна и как внедрить за две недели без сопротивления сотрудников. Шаблон таблицы внутри. #менеджмент', hoursAgo: 11 },
      { n: 2, text: 'Денежный разрыв: почему прибыльные компании банкротятся. Разбираем кассовые разрывы на живом примере и показываем, как построить платёжный календарь. #финансы', media: 'market.png', hoursAgo: 27 },
      { n: 3, text: 'Делегирование без страха: чек-лист из девяти шагов, как передать задачи и не переделывать за сотрудником. Проверено на сорока командах. #управление', hoursAgo: 49 },
      { n: 4, text: 'CRM или таблица? Считаем точку окупаемости: при каком числе сделок таблицы перестают справляться. Спойлер: раньше, чем вы думаете. #CRM #процессы', media: 'business.png', hoursAgo: 71 },
    ],
  },
  // ---- travel (2 канала → +2) ----
  {
    username: 'travelhack_feed', title: 'Тревел Хаки', description: 'Лайфхаки путешествий: визы, билеты, страховки',
    color: '#00acc1', category: 'travel', premium: true, subs: 63900,
    posts: [
      { n: 1, text: 'Виза в Японию стала проще: документы принимают в визовых центрах без записи, срок — 5 рабочих дней. Чек-лист документов и частые причины отказа. #визы #япония', media: 'travel.png', hoursAgo: 6 },
      { n: 2, text: 'Авиабилеты: почему один и тот же рейс стоит 12 и 34 тысячи. Разбираем логику тарифов, время открытия продаж и как ловить ошибки операторов. #билеты #лайфхаки', hoursAgo: 20 },
      { n: 3, text: 'Страховка для путешествий: сравнили девять компаний по покрытию активного отдыха и экстрима. Разница в цене — до четырёх раз при одинаковом лимите. #страховки', hoursAgo: 42 },
      { n: 4, text: 'Казань за выходные: маршрут без музеев — набережная, старотатарские улицы и лучший элеш в городе. Бюджет: 7 тысяч на двоих. #россия #маршруты', media: 'travel.png', hoursAgo: 65 },
    ],
  },
  {
    username: 'travelgeo_feed', title: 'Гео Тревел', description: 'География путешествий: места, маршруты, природа',
    color: '#8d6e63', category: 'travel', premium: false, subs: 15600,
    posts: [
      { n: 1, text: 'Алтай осенью: почему сентябрь — лучшее время. Толпы ушли, лиственницы горят золотом, а на Чуйском тракте ещё тепло. Маршрут на четыре дня с картой. #алтай #природа', media: 'travel.png', hoursAgo: 13 },
      { n: 2, text: 'Место силы: Кольский полуостров. Сидна — сакральная саамская гора, куда почти никто не доезжает. Как добраться и почему стоит успеть до первого снега. #кольский #север', hoursAgo: 30 },
      { n: 3, text: 'Пещера Эмине-Баир-Хосар в Крыму: галереи длиной полтора километра, кости мамонта и сталактиты возрастом восемь миллионов лет. Информация для посещения внутри. #крым #пещеры', media: 'travel.png', hoursAgo: 55 },
    ],
  },
  // ---- food (2 канала → +2) ----
  {
    username: 'foodformula_feed', title: 'Формула Еды', description: 'Простые рецепты с точными граммовками',
    color: '#d81b60', category: 'food', premium: true, subs: 88300,
    posts: [
      { n: 1, text: 'Борщ по формуле: три части капусты, две части свёклы, одна часть томатов. Полный рецепт с граммовками и порядком закладки — заправка за 20 минут. #рецепты #борщ', media: 'food.png', hoursAgo: 3 },
      { n: 2, text: 'Куриные крылышки в медово-соевом маринаде: четыре ингредиента, 30 минут в духовке. Секрет хрустящей корочки — разрыхлитель и сухая кожа. #ужин #курица', hoursAgo: 18 },
      { n: 3, text: 'Домашний хлеб на закваске без замеса: смешал, забыл на 12 часов, испёк. Хрустящая корочка и открытый мякиш гарантированы. #хлеб #выпечка', media: 'food.png', hoursAgo: 40 },
      { n: 4, text: 'Пять соусов, которые спасут любой ужин: бешамель, терияки, чимичурри, тартар и кисло-сладкий. Все — из того, что уже есть на кухне. #соусы #рецепты', hoursAgo: 64 },
    ],
  },
  {
    username: 'foodguru_feed', title: 'Еда Гуру', description: 'Про продукты, кухню и гастрономию',
    color: '#795548', category: 'food', premium: false, subs: 19700,
    posts: [
      { n: 1, text: 'Как выбрать оливковое масло и не переплатить: extra virgin, кислотность, дата отжима и почему тёмное стекло важнее страны происхождения. #продукты #масло', hoursAgo: 9 },
      { n: 2, text: 'Стейк из свинины недооценён: на примере шейки показываем, что температурный контроль важнее мраморности. Таблица прожарок внутри. #мясо #гриль', media: 'food.png', hoursAgo: 25 },
      { n: 3, text: 'Сырная тарелка за 800 рублей: три сорта, которые создают впечатление «полкило бри». Правила сочетания с мёдом, орехами и виноградом. #сыр #подача', hoursAgo: 51 },
    ],
  },
  // ---- sport (2 канала → +2) ----
  {
    username: 'sportlive_feed', title: 'Спорт Лайв', description: 'Онлайн-результаты и текстовые трансляции матчей',
    color: '#2e7d32', category: 'sport', premium: true, subs: 81500,
    posts: [
      { n: 1, text: 'Лайв: центральный матч тура идёт без забитых мячей, но уже с двенадцатью ударами. Хозяева владеют мячом 61% и давят флангами. Все моменты — в нашей текстовой трансляции. #лайв #футбол', media: 'sport.png', hoursAgo: 1 },
      { n: 2, text: 'НХЛ: русские вратари оформили сухарь и серию сейвов в овертайме одной ночью. Обзор лучших эпизодов с оценками экспертов. #хоккей #НХЛ', hoursAgo: 16 },
      { n: 3, text: 'Баскетбол: овертайм в матче за первое место, три секунды до финальной сирены и трёхочковый через руки защитника. Видео момента внутри. #баскетбол', media: 'sport.png', hoursAgo: 36 },
      { n: 4, text: 'Теннис: наша теннисистка вышла в полуфинал турнира WTA, обыграв третью ракетку посева 6:4, 7:6. Хронология ключевых геймов. #теннис #WTA', hoursAgo: 61 },
    ],
  },
  {
    username: 'sportarena_feed', title: 'Спорт Арена', description: 'Стадионы, болельщики и атмосфера больших игр',
    color: '#1565c0', category: 'sport', premium: false, subs: 36100,
    posts: [
      { n: 1, text: 'Новый стадион на 45 тысяч мест прошёл сертификацию: раздвижное поле, крыша-«бабочка» и самая большая экранная стена в стране. Фотографии внутри. #стадионы', media: 'sport.png', hoursAgo: 10 },
      { n: 2, text: 'Атмосфера дерби: 38 тысяч зрителей, перформанс с дронами и 90 минут непрерывных кричалок. Как это выглядело с трибуны — фоторепортаж. #дерби #болельщики', media: 'sport.png', hoursAgo: 24 },
      { n: 3, text: 'Гид по фан-зонам: где смотреть домашние матчи на большом экране. Вход свободный, везде работают точки с едой и парковки. #фанзоны #футбол', hoursAgo: 48 },
      { n: 4, text: 'Легенда трибун: вспомним рекорд посещаемости, который держится 40 лет — 105 тысяч зрителей на одном матче. История с архивными кадрами. #история', media: 'sport.png', hoursAgo: 70 },
    ],
  },
]

// ---------- Основная логика ----------

async function main() {
  console.log('=== TG-Feed seed-more: расширение демо-данных ===')

  const channelsBefore = await db.channel.count()
  const postsBefore = await db.post.count()
  console.log(`До: каналов ${channelsBefore}, постов ${postsBefore}`)

  // Категории по slug
  const categories = await db.category.findMany({ select: { id: true, slug: true } })
  const catIdBySlug = new Map(categories.map((c) => [c.slug, c.id]))

  // Текущее число каналов в каждой категории → решаем, сколько добавлять (цель: 4-5 на категорию)
  const chByCat = await db.channel.groupBy({ by: ['categoryId'], _count: { _all: true } })
  const countByCatId = new Map(chByCat.map((g) => [g.categoryId, g._count._all]))

  let channelsAdded = 0
  let channelsUpdated = 0
  let postsAdded = 0
  let postsUpdated = 0
  let mediaUsed = 0

  // Группируем новые каналы по категориям (внутри категории — порядок объявления)
  const byCategory = new Map<string, SeedChannel[]>()
  for (const ch of NEW_CHANNELS) {
    const list = byCategory.get(ch.category) ?? []
    list.push(ch)
    byCategory.set(ch.category, list)
  }

  for (const [slug, group] of byCategory) {
    const catId = catIdBySlug.get(slug)
    if (!catId) {
      console.warn(`! Категория «${slug}» не найдена — пропуск (${group.map((g) => g.username).join(', ')})`)
      continue
    }
    const existing = countByCatId.get(catId) ?? 0
    // Цель: минимум 4 канала в категории; максимум +2 новых за прогон.
    // Уже созданные нами каналы обновляются всегда (идемпотентный update-путь).
    let createQuota = Math.max(0, Math.min(2, 4 - existing))
    const selected: SeedChannel[] = []
    for (const ch of group) {
      const exists = await db.channel.findUnique({ where: { username: ch.username }, select: { id: true } })
      if (exists) selected.push(ch)
      else if (createQuota > 0) {
        selected.push(ch)
        createQuota--
      }
    }
    if (selected.length === 0) {
      console.log(`[${slug}] уже ${existing} каналов — новые не требуются`)
      continue
    }
    console.log(`[${slug}] каналов сейчас ${existing}, обрабатываем ${selected.length} (новые + обновления)`)

    for (let ci = 0; ci < selected.length; ci++) {
      const ch = selected[ci]
      const globalIdx = NEW_CHANNELS.indexOf(ch)
      const premium = !!ch.premium
      // premiumUntil: детерминированно 14–38 дней для премиум-каналов
      const premiumUntil = premium ? new Date(Date.now() + (14 + (globalIdx % 5) * 6) * 86400e3) : null

      const existedBefore = await db.channel.findUnique({ where: { username: ch.username }, select: { id: true } })
      const channel = await withRetry(
        () =>
          db.channel.upsert({
            where: { username: ch.username },
            create: {
              tgId: `-1002900000${String(globalIdx + 1).padStart(2, '0')}`,
              title: ch.title,
              username: ch.username,
              description: ch.description,
              avatarColor: ch.color,
              categoryId: catId,
              isPremium: premium,
              premiumUntil,
              status: 'active',
              subscribersCount: ch.subs,
              clicksCount: Math.round(ch.subs * 0.03), // ~3% подписчиков
            },
            update: {
              title: ch.title,
              description: ch.description,
              avatarColor: ch.color,
              categoryId: catId,
              isPremium: premium,
              premiumUntil,
              status: 'active',
              subscribersCount: ch.subs,
              clicksCount: Math.round(ch.subs * 0.03),
            },
          }),
        `channel.upsert(${ch.username})`,
      )

      if (existedBefore) channelsUpdated++
      else channelsAdded++

      for (const p of ch.posts) {
        // Правдоподобные метрики, детерминированные по (канал, пост)
        const rng = mulberry32(91000 + globalIdx * 100 + p.n)
        const views = Math.round(ch.subs * (0.10 + rng() * 0.70)) // 10–80% подписчиков
        const likes = Math.round(views * (0.02 + rng() * 0.04)) // 2–6% просмотров
        const mediaOk = p.media ? hasMedia(p.media) : false
        if (mediaOk) mediaUsed++
        else if (p.media) console.warn(`! Медиа ${p.media} не найдено — пост «${ch.username}:${p.n}» станет текстовым`)

        const publishedAt = new Date(Date.now() - p.hoursAgo * 3600e3)
        const tgKey = `seed:${ch.username}:${p.n}`

        const existingPost = await db.post.findUnique({ where: { tgKey }, select: { id: true } })
        await withRetry(
          () =>
            db.post.upsert({
              where: { tgKey },
              create: {
                tgKey,
                channelId: channel.id,
                text: p.text,
                mediaUrl: mediaOk ? `/media/${p.media}` : null,
                mediaType: 'image',
                gallery: null,
                link: `https://t.me/${ch.username}/${p.n}`,
                viewsCount: views,
                likesCount: likes,
                publishedAt,
              },
              update: {
                channelId: channel.id,
                text: p.text,
                mediaUrl: mediaOk ? `/media/${p.media}` : null,
                mediaType: 'image',
                gallery: null,
                link: `https://t.me/${ch.username}/${p.n}`,
                viewsCount: views,
                likesCount: likes,
                publishedAt,
              },
            }),
          `post.upsert(${tgKey})`,
        )
        if (existingPost) postsUpdated++
        else postsAdded++
      }
    }
  }

  const channelsAfter = await db.channel.count()
  const postsAfter = await db.post.count()
  console.log('--- Итог ---')
  console.log(`Каналы: ${channelsBefore} → ${channelsAfter} (новых ${channelsAdded}, обновлено ${channelsUpdated})`)
  console.log(`Посты: ${postsBefore} → ${postsAfter} (новых ${postsAdded}, обновлено ${postsUpdated})`)
  console.log(`Постов с медиа в этой партии: ${mediaUsed}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
