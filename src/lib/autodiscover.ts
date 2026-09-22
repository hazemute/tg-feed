import { db } from '@/lib/db'
import { redis, bumpCache } from '@/lib/redis'
import { emitAppEvent } from '@/lib/events'
import { isValidChannelUsername } from '@/lib/server'
import { parseChannelHtml, upgradeCustomEmoji, isRussianText } from '@/lib/parse-engine'
import { cleanPostText } from '@/lib/text-clean'
import { getChatInfo, getChatMemberCount } from '@/lib/tg-bot'
import { classifyChannelsBatch } from '@/lib/classify'

/**
 * АВТОСБОР КАНАЛОВ — «нажал кнопку, всё остальное делает движок».
 *
 * Как работает:
 *  1. СТАРТ: в очередь ставится кураторский каталог реальных крупных
 *     публичных каналов (проверенных вручную), плюс уже известные в БД
 *     считаются посещёнными.
 *  2. ШАГ (клиент-управляемый): из очереди берётся до `batch` кандидатов,
 *     по каждому — fetch веб-превью t.me/s/<username>. Если страницы нет
 *     или постов нет — кандидат отклоняется (мёртвый/приватный).
 *  3. Метаданные канала — одним вызовом Bot API getChat (id, название,
 *     описание, аватарка), подписчики — getChatMemberCount. Категория
 *     подбирается keyword-классификатором по названию/описанию.
 *  4. Канал создаётся в БД, новейшие посты с превью складываются в ленту
 *     (реальные счётчики: лайки/просмотры = 0, никакой синтетики).
 *  5. ИЗ ТЕКСТОВ И HTML постов вытягиваются новые кандидаты
 *     (t.me/<name> ссылки и @mentions) — обход графа каналов в ширину.
 *
 * Почему шаги, а не один долгий запрос: серверлес-функция может быть
 * заморожена по таймауту — клиент сам ведёт цикл («шаг → прогресс → ещё
 * шаг»), каждый шаг укладывается в лимиты. Состояние живёт в Redis
 * (sys:autodiscover) — переживает холодные старты и не зависит от инстанса.
 */

const STATE_KEY = 'sys:autodiscover'
const STATE_TTL_SEC = 6 * 60 * 60 // состояние само сгорает через 6 часов
const STALE_MS = 3 * 60 * 1000 // «running» считается зависшим без шагов 3 минуты
const QUEUE_CAP = 1200 // каскад из каталогов: очередь пополняется по мере разбора
const DEFAULT_MAX_NEW = 60
const MAX_NEW_LIMIT = 300
const POSTS_PER_NEW_CHANNEL = 60 // v5.77: глубже с первого раза (цель — 1000+ постов/категорию)
const MIN_MEMBERS = 100 // фильтр качества: каналы-пустышки не тянут в ленту
const REFILL_THRESHOLD = 30 // при такой очереди — подпитаться из источников

export type AutodiscoverSource = 'all' | 'tgstat' | 'combot' | 'curated'

export type AutodiscoverLine = { at: number; msg: string }
export type AutodiscoverAdded = {
  username: string
  title: string
  category: string
  posts: number
  members: number | null
}
export type AutodiscoverState = {
  running: boolean
  phase: 'idle' | 'working' | 'done' | 'stopped'
  source: AutodiscoverSource
  queueSize: number
  visitedCount: number
  processedCount: number
  channelsAdded: number
  postsAdded: number
  rejectedCount: number
  maxNew: number
  /** Источников ещё не израсходовано (страницы каталогов/запросы API) */
  sourcesLeft: number
  added: AutodiscoverAdded[]
  rejected: { username: string; reason: string }[]
  log: AutodiscoverLine[]
  startedAt: number
  updatedAt: number
}

type InternalState = Omit<AutodiscoverState, 'queueSize' | 'visitedCount' | 'processedCount' | 'sourcesLeft'> & {
  queue: string[]
  visited: string[]
  processed: number
  sourceJobs: SourceJob[]
}

// ------------------------- Источники кандидатов -------------------------

/**
 * Каскад источников: очередь каналов пополняется по ходу разбора — как только
 * в ней остаётся меньше REFILL_THRESHOLD кандидатов, движок подтягивает
 * следующую порцию из каталогов. За счёт этого один прогон может обработать
 * тысячи кандидатов без единого ручного списка.
 *
 *  - tgstat-api  — официальное API TGStat (если в env задан TGSTAT_API_TOKEN);
 *  - tgstat-html — рейтинги tgstat.ru (могут быть закрыты Cloudflare — тогда
 *                  источник честно пропускается с записью в лог);
 *  - combot      — открытые топы combot.org (каналы + группы, пагинация),
 *                  проверенно доступен без авторизации;
 *  - curated     — кураторский список проверенных крупных каналов;
 *  - граф t.me   — упоминания в постах уже добавленных каналов (BFS).
 */

type SourceJob =
  | { kind: 'curated' }
  | { kind: 'tgstat-api'; q: string }
  | { kind: 'tgstat-html'; url: string }
  | { kind: 'combot'; url: string }

const TGSTAT_QUERIES = [
  'новости',
  'криптовалюта',
  'IT и программирование',
  'юмор',
  'бизнес и инвестиции',
  'спорт',
  'путешествия',
  'еда и кулинария',
  'кино и сериалы',
]

const TGSTAT_PAGES = [
  'https://tgstat.ru/ratings/channels',
  'https://tgstat.com/ratings/channels',
]

const COMBOT_TOPS = [
  ...[1, 2, 3, 4, 5, 6].map((p) => `https://combot.org/top/telegram/channels?page=${p}`),
  ...[1, 2].map((p) => `https://combot.org/top/telegram/groups?page=${p}`),
]

function tgstatToken(): string {
  return process.env.TGSTAT_API_TOKEN?.trim() ?? ''
}

function buildSourceJobs(source: AutodiscoverSource): SourceJob[] {
  const jobs: SourceJob[] = []
  const wantTgstat = source === 'all' || source === 'tgstat'
  const wantCombot = source === 'all' || source === 'combot'
  const wantCurated = source === 'all' || source === 'curated'
  if (wantTgstat && tgstatToken()) {
    for (const q of TGSTAT_QUERIES) jobs.push({ kind: 'tgstat-api', q })
  }
  if (wantTgstat) for (const url of TGSTAT_PAGES) jobs.push({ kind: 'tgstat-html', url })
  if (wantCombot) for (const url of COMBOT_TOPS) jobs.push({ kind: 'combot', url })
  if (wantCurated) jobs.push({ kind: 'curated' })
  return jobs
}

const FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

async function fetchPage(url: string, timeoutMs = 15_000): Promise<{ ok: boolean; status: number; body: string }> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': FETCH_UA, 'Accept-Language': 'ru,en;q=0.9' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await res.text()
    return { ok: res.ok, status: res.status, body }
  } catch {
    return { ok: false, status: 0, body: '' }
  }
}

/** Cloudflare-челлендж: страница отдалась, но каналов в ней нет */
function isCloudflareChallenge(body: string): boolean {
  return body.includes('Just a moment') || body.includes('challenges.cloudflare.com')
}

/** Достать @username-значения из JSON (ответы API TGStat и __NEXT_DATA__) */
function extractFromJson(text: string): string[] {
  const out = new Set<string>()
  const re = /"(?:username|link|url|channel)\s*"\s*:\s*"(?:@?t\.me\/s?\/)?([A-Za-z][A-Za-z0-9_]{3,31})"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.add(m[1])
  return [...out]
}

// ------------------------- Каталог-старт -------------------------

/**
 * Кураторский список реальных публичных каналов для первого прогона.
 * Каждый кандидат всё равно валидируется (t.me/s должен отвечать живой
 * страницей с постами) — несуществующие юзернеймы тихо отклоняются,
 * так что список можно расширять без риска.
 */
/*
 * v5.77: КУРАТОРСКИЙ КАТАЛОГ — ТОЛЬКО ИГРОВЫЕ РУССКИЕ КАНАЛЫ.
 * Приказ владельца: «парсились пока что только ИГРОВЫЕ КАНАЛЫ и посты».
 * Раньше было 10 категорий (мемы/кино/аниме/IT/новости…) — теперь одна games.
 * Ядро — крупнейшие русские игровые медиа; дальший рост — BFS по упоминаниям
 * (extractCandidates) + автосбор tgstat/combot с games-фильтром (ONLY_SLUG).
 * Несуществующие юзернеймы безвредны: processCandidate проверяет t.me/s
 * (посты + ≥100 подписчиков) и просто не создаёт канал.
 */
export const CATALOG: Array<{ slug: string; usernames: string[] }> = [
  {
    slug: 'games',
    // v5.78: ВЕРИФИЦИРОВАННЫЙ каталог — каждый username проверен live-тестом
    // t.me/s (веб-превью отвечает и содержит посты; checked 2025-09-22).
    // Старый список (v5.77) содержал 61/77 мёртвых имён — Telegram отдаёт на
    // них карточку канала без постов, discover добавил 5 каналов и лента
    // осталась пустой. У мёртвых имён здесь больше нет места.
    usernames: [
      // ── крупные игровые медиа (RU) ──
      'igromania', // ~160 постов в превью
      'dtfru', // DTF
      'stopgameru', // StopGame.ru (рабочий username, 'stopgame_ru' мёртв)
      'playground_ru', // PlayGround.ru ('playgrounderu' мёртв)
      'vgtimes', // VGTimes
      'kanobu',
      'kanobu_ru',
      'gamebomb',
      'kg_portal',
      'gamemag_ru', // og-мета латиницей — спасает проверка текстов постов
      // ── платформы и магазины ──
      'epicgamesru',
      'playstationru',
      'playstation_igry',
      'sonyplaystation',
      'nintendo_ru',
      'nintendoswitchru',
      'steam_deals_ru',
      'steamru',
      'mobilegames_ru', // «Мобильный Геймер»
      // ── киберспорт и шутеры ──
      'virtuspro',
      'cybersport_ru_news',
      'dota2ru',
      'dota2',
      'dota2news',
      'cs2_ru',
      'cs_ru',
      'cs2news',
      'csgo_ru',
      'standoff2',
      // ── MMO и онлайн ──
      'aion_ru',
      'blackdesert_ru', // посты русские — og-мета латиница
      'wowcircle_official',
      'lostarkru',
      'blizzard_ru',
      'hearthstone',
      'rustbase', // «Ржавая База» (Rust)
      // ── сообщества отдельных игр ──
      'genshin_ru',
      'honkaistarrail_ru',
      'zenlesszonezero_ru',
      'wutheringwaves_ru',
      'eldenringru',
      'gta6_ru',
      'terraria_ru',
      'cities_skylines_ru',
      'civilization_ru',
      'starcitizen_ru',
      'project_zomboid_ru',
      'hunt_showdown_ru',
      'dbd_ru',
      'dead_by_daylight_ru',
      'thefirstdescendant_ru',
      'content_warning_ru',
      'tf2_ru',
      'rimworld_ru',
      'phasmophobia_ru',
      // ── геймдев и инди ──
      'indiegameru',
      'gamedevru',
      'unreal_engine_ru',
      // ── v5.95: ВТОРАЯ ВОЛНА — каждый username живьём проверен t.me/s
      // (веб-превью + посты; checked 2025-09-22, урок v5.78: мёртвых имён нет) ──
      'gabestore', // GABESTORE — магазин игр
      'natus_vincere',
      'team_spirit',
      'worldoftanks',
      'warthunder', // War Thunder RU
      'tarkov', // Escape from Tarkov
      'pubg_mobile',
      'league_of_legends_ru',
      'worldofwarships',
      'mmorpg', // MMORPG RU
      'valve_ru',
      'stalcraft', // STALCRAFT
      'stalker2_ru', // S.T.A.L.K.E.R. 2
      'ksp_ru', // Kerbal Space Program RU
      'androidgames_ru',
      'mangodota', // Mango Dota — медиа Dota 2
      'allstarsleague', // AllStars League
      'ggsel', // GGSel — маркетплейс игр
      'gigagames', // GigaGames
      'psnstore_ru', // PSN Store RU
      'steam_community_ru',
      'games_keys', // игровые ключи
      'ggdeals', // GG.deals — скидки
      'vgtimes_discounts',
      'vgtimes_plus',
      'virtuspro_cs2',
      'virtuspro_dota',
      'virtuspro_mlbb',
      'virtuspro_mobile',
      'virtuspro_pubg',
      'virtuspro_r6',
      'virtusproapex',
    ],
  },
]

/** Служебные пути t.me, которые не являются каналами */
const TG_SERVICE_PATHS = new Set([
  'share',
  'joinchat',
  'addstickers',
  'addemoji',
  'proxy',
  'iv',
  'setlanguage',
  'login',
  'contact',
  'premium',
  'privacy',
  'tos',
  'blog',
  'faq',
  'apps',
  'features',
  'telegram',
  'telegramorg',
  'webgram',
  'a',
  's',
  'c',
  'theme',
  'desktop',
  'android',
  'ios',
  'macos',
  'web',
  'features#',
])

// ------------------------- Классификатор категорий -------------------------

const CATEGORY_HINTS: Array<{ slug: string; re: RegExp }> = [
  // v5.77: игры — ПЕРВЫЙ хинт (приоритет): их больше всего в автосборе и они целевая категория
  { slug: 'games', re: /игр|гейм|game|игров|киберсп|esport|e-?sport|steam|playstation|\bxbox\b|nintendo|геймер|геймпад|консол|стрим|летсплей|твич|twitch|dota|cs\b|cs2|вальв|valve|minecraft|роблокс|fortnite|ганшин|genshin|warframe|тарков|tarkov/i },
  { slug: 'news', re: /новост|breaking|срочн|сводк|лентач|mash|риа|відомост|ведомост|коммерсант|газет|agenc|news|media/i },
  { slug: 'crypto', re: /крипт|биткоин|bitcoin|btc|ethereum|eth\b|альткоин|токен|трейд|coin|defi|crypto|blockchain|блокчейн/i },
  { slug: 'it', re: /\bit\b|разработ|программ|код|python|javascript|frontend|backend|нейросет|ии\b|ai\b|gpt|tech|гаджет|стартап-тех|хакер|dev|software|дизайн/i },
  { slug: 'humor', re: /юмор|мем|шутк|прикол|сарказм|смешн|humor|memes/i },
  { slug: 'business', re: /бизнес|деньг|финанс|инвест|маркетинг|продаж|менеджмент|ваканс|работа|карьер|экономик/i },
  { slug: 'travel', re: /путешеств|туризм|travel|билет|отель|поездк|авиабилет/i },
  { slug: 'food', re: /ед|рецепт|готов|кулинар|кофе|чай|десерт|food|повар/i },
  { slug: 'sport', re: /спорт|футбол|хоккей|баскет|матч|олимпиад|чемпионат|sport|фк\b|ucl|fifa/i },
]

/**
 * v5.77: GAMES-ONLY режим автосбора — SystemSetting 'autodiscover:only_slug'.
 * Пока задан ('games'): в базу добавляются ТОЛЬКО каналы этой категории
 * (регэксп-классификация + LLM-уточнение не могут их уводить в другие слиги).
 * null = без ограничений. Выставляется миграцией content-catalog v2.
 */
export async function getOnlySlug(): Promise<string | null> {
  try {
    const row = await db.systemSetting.findUnique({ where: { key: 'autodiscover:only_slug' } })
    const v = row?.value?.trim()
    return v && v !== '' ? v : null
  } catch {
    return null
  }
}

function classifyCategory(text: string, fallback = 'other'): string {
  for (const h of CATEGORY_HINTS) if (h.re.test(text)) return h.slug
  return fallback
}

// ------------------------- Состояние -------------------------

function freshState(maxNew: number, source: AutodiscoverSource): InternalState {
  return {
    running: true,
    phase: 'working',
    source,
    queue: [],
    visited: [],
    processed: 0,
    channelsAdded: 0,
    postsAdded: 0,
    rejectedCount: 0,
    maxNew,
    sourceJobs: [],
    added: [],
    rejected: [],
    log: [{ at: Date.now(), msg: 'Старт автосбора' }],
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }
}

async function loadState(): Promise<InternalState | null> {
  if (!redis) return null
  try {
    const raw = await redis.get<InternalState>(STATE_KEY)
    if (!raw || typeof raw !== 'object') return null
    if (!Array.isArray(raw.queue) || !Array.isArray(raw.visited)) return null
    return raw
  } catch {
    return null
  }
}

async function saveState(s: InternalState): Promise<void> {
  if (!redis) return
  try {
    s.updatedAt = Date.now()
    await redis.set(STATE_KEY, s, { ex: STATE_TTL_SEC })
  } catch {
    /* состояние не сохранилось — шаги продолжат работать, но восстановление после сбоя невозможно */
  }
}

function toPublic(s: InternalState): AutodiscoverState {
  return {
    running: s.running,
    phase: s.phase,
    source: s.source,
    queueSize: s.queue.length,
    visitedCount: s.visited.length,
    processedCount: s.processed,
    channelsAdded: s.channelsAdded,
    postsAdded: s.postsAdded,
    rejectedCount: s.rejectedCount,
    maxNew: s.maxNew,
    sourcesLeft: s.sourceJobs.length,
    added: s.added.slice(-100),
    rejected: s.rejected.slice(-40),
    log: s.log.slice(-40),
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
  }
}

function pushLog(s: InternalState, msg: string): void {
  s.log.push({ at: Date.now(), msg })
  if (s.log.length > 60) s.log.splice(0, s.log.length - 40)
}

/** Существующие username'ы каналов (для защиты от дублей) */
async function knownUsernames(): Promise<Set<string>> {
  const rows = await db.channel.findMany({ select: { username: true } })
  return new Set(rows.map((r) => r.username.toLowerCase()))
}

// ------------------------- Каскад источников -------------------------

/** Добавить кандидата в очередь, если он свежий, валидный по формату и не дубль */
function pushCandidate(s: InternalState, c: string, seen: Set<string>): boolean {
  const u = c.trim().replace(/^@/, '')
  const lower = u.toLowerCase()
  if (!lower || seen.has(lower)) return false
  if (!isValidChannelUsername(u) || TG_SERVICE_PATHS.has(lower) || /bot$/i.test(u)) return false
  seen.add(lower)
  if (s.queue.length < QUEUE_CAP) s.queue.push(u)
  return true
}

/**
 * Подпитать очередь из следующего источника, если она истощается.
 * Вызывается на каждом шаге — один вызов берёт максимум один источник,
 * чтобы шаг не превысил серверлес-лимиты (страница каталога ~ 1–3с).
 */
async function refillFromSources(s: InternalState): Promise<void> {
  if (s.queue.length >= REFILL_THRESHOLD || s.sourceJobs.length === 0) return

  // транзитный дедуп-набор: посещённые + уже в очереди
  const seen = new Set<string>(s.queue.map((q) => q.toLowerCase()))
  for (const v of s.visited) seen.add(v.toLowerCase())

  const job = s.sourceJobs.shift()!

  if (job.kind === 'curated') {
    let added = 0
    for (const group of CATALOG) {
      for (const u of group.usernames) if (pushCandidate(s, u, seen)) added++
    }
    pushLog(s, `Источник «кураторский каталог»: +${added} кандидатов`)
    return
  }

  if (job.kind === 'tgstat-api') {
    const token = tgstatToken()
    if (!token) return
    try {
      const url = `https://api.tgstat.ru/v/channels/search?token=${encodeURIComponent(token)}&q=${encodeURIComponent(job.q)}&limit=25&language=ru`
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      const body = await res.text()
      if (!res.ok) {
        pushLog(s, `TGStat API: HTTP ${res.status} — источник недоступен, остальные продолжат`)
        return
      }
      let added = 0
      for (const c of extractFromJson(body)) if (pushCandidate(s, c, seen)) added++
      for (const c of extractCandidates(body)) if (pushCandidate(s, c, seen)) added++
      pushLog(s, `TGStat API «${job.q}»: +${added} кандидатов`)
    } catch {
      pushLog(s, `TGStat API «${job.q}»: таймаут/ошибка сети`)
    }
    return
  }

  if (job.kind === 'tgstat-html') {
    const r = await fetchPage(job.url)
    if (!r.ok || isCloudflareChallenge(r.body)) {
      pushLog(
        s,
        `tgstat.ru закрыт Cloudflare (HTTP ${r.status}) — кандидаты возьмутся из других источников`,
      )
      return
    }
    let added = 0
    for (const c of extractCandidates(r.body)) if (pushCandidate(s, c, seen)) added++
    pushLog(s, `tgstat.ru рейтинги: +${added} кандидатов`)
    return
  }

  // combot: открытые топы каналов и групп, ~100 кандидатов на страницу
  const r = await fetchPage(job.url)
  if (!r.ok || isCloudflareChallenge(r.body)) {
    pushLog(s, `combot.org HTTP ${r.status} — страница пропущена`)
    return
  }
  let added = 0
  for (const c of extractCandidates(r.body)) if (pushCandidate(s, c, seen)) added++
  const page = /page=(\d+)/.exec(job.url)?.[1] ?? '1'
  pushLog(s, `combot.org топ (стр. ${page}): +${added} кандидатов`)
}

// ------------------------- Публичное API -------------------------

/**
 * Запустить новый сбор. Возвращает false, если сбор уже идёт (и не завис).
 * source — какие источники кандидатов использовать (по умолчанию все).
 */
export async function startAutodiscover(
  maxNew?: number,
  source: AutodiscoverSource = 'all',
): Promise<{ ok: boolean; reason?: string }> {
  const prev = await loadState()
  if (prev && prev.running && Date.now() - prev.updatedAt < STALE_MS) {
    return { ok: false, reason: 'сбор уже выполняется' }
  }

  const s = freshState(
    Math.max(5, Math.min(MAX_NEW_LIMIT, Math.floor(maxNew ?? DEFAULT_MAX_NEW))),
    source,
  )

  // посещёнными считаем уже существующие каналы из БД + предзаготовленные источники
  const known = await knownUsernames()
  s.visited = [...known]
  s.sourceJobs = buildSourceJobs(source)

  // первая подпитка из источников — сразу при старте, чтобы цикл шагов
  // не начинался с пустой очереди
  await refillFromSources(s)

  pushLog(
    s,
    `Очередь: ${s.queue.length} кандидатов, в базе ${known.size} каналов, источников осталось ${s.sourceJobs.length}`,
  )
  await saveState(s)
  return { ok: true }
}

/** Остановить сбор (мягко: текущий шаг дообработается). */
export async function stopAutodiscover(): Promise<AutodiscoverState | null> {
  const s = await loadState()
  if (!s) return null
  s.running = false
  s.phase = 'stopped'
  pushLog(s, 'Остановлено оператором')
  await saveState(s)
  return toPublic(s)
}

/** Текущее состояние (для GET панели). */
export async function autodiscoverState(): Promise<AutodiscoverState | null> {
  const s = await loadState()
  if (!s) return null
  // зависший сбор (инстанс умер между шагами) — пометим остановленным
  if (s.running && Date.now() - s.updatedAt > STALE_MS) {
    s.running = false
    s.phase = 'stopped'
    pushLog(s, 'Сбор остановлен автоматически: шаги прекратились')
    await saveState(s)
  }
  return toPublic(s)
}

/**
 * Один шаг: обработать до `batch` кандидатов из очереди.
 * Вызывается панелью в цикле, пока state.running.
 */
export async function autodiscoverStep(batch = 3): Promise<AutodiscoverState | null> {
  let s = await loadState()
  if (!s) return null
  if (!s.running) return toPublic(s)

  const knownCats = new Map(
    (await db.category.findMany({ select: { id: true, slug: true } })).map((c) => [c.slug, c.id]),
  )
  const otherId = knownCats.get('other') ?? [...knownCats.values()][0]
  const known = await knownUsernames()
  const visited = new Set(s.visited.map((v) => v.toLowerCase()))
  for (const k of known) visited.add(k)

  // каскад: очередь истощается → берём следующую порцию из каталогов
  await refillFromSources(s)

  let didAdd = false
  let processedThisStep = 0

  for (let i = 0; i < batch; i++) {
    const candidate = s.queue.shift()
    if (!candidate) break
    if (s.channelsAdded >= s.maxNew) {
      pushLog(s, `Достигнут лимит прогона: ${s.maxNew} каналов`)
      break
    }

    // username нормализуем СРАЗУ в нижний регистр: Telegram-имена регистронезависимы,
    // все выборки в приложении идут в lowercase — смешанный регистр в БД ломал
    // открытие канала/подписку (баг «Канал не найден»)
    const uname = candidate.trim().replace(/^@/, '').toLowerCase()
    const lower = uname.toLowerCase()

    // формат / служебные / боты / дубли
    if (!isValidChannelUsername(uname) || TG_SERVICE_PATHS.has(lower) || /bot$/i.test(uname)) {
      s.visited.push(lower)
      s.processed++
      processedThisStep++
      continue
    }
    if (visited.has(lower)) {
      s.processed++
      processedThisStep++
      continue
    }
    visited.add(lower)
    s.visited.push(lower)

    const res = await processCandidate(uname, s, knownCats, otherId)
    if (res.ok) {
      s.channelsAdded++
      s.postsAdded += res.posts
      didAdd = true
      s.added.push({
        username: uname,
        title: res.title,
        category: res.category,
        posts: res.posts,
        members: res.members,
      })
      pushLog(s, `+ @${uname} — «${res.title}» (${res.posts} постов)`)
    } else {
      s.rejectedCount++
      s.rejected.push({ username: uname, reason: res.reason })
      if (s.rejected.length > 40) s.rejected.splice(0, s.rejected.length - 40)
      pushLog(s, `– @${uname}: ${res.reason}`)
    }
    s.processed++
    processedThisStep++

    // очередь выросла — кандидаты из текстов
    if (s.queue.length > 0) {
      s.queue = s.queue.filter((q) => !visited.has(q.toLowerCase())).slice(0, QUEUE_CAP)
    }
  }

  // очередь исчерпана → завершение (если больше некуда подпитаться)
  if (s.queue.length === 0 && (s.sourceJobs.length === 0 || s.channelsAdded >= s.maxNew)) {
    s.running = false
    s.phase = 'done'
    pushLog(
      s,
      `Готово: +${s.channelsAdded} каналов, ${s.postsAdded} постов, отклонено ${s.rejectedCount}`,
    )
  }

  await saveState(s)

  if (didAdd) {
    await bumpCache(['feed', 'tr', 'ct', 'ch', 'sr']).catch(() => undefined)
    if (s.phase === 'done') {
      emitAppEvent('posts:new', { total: s.postsAdded, usernames: s.added.map((a) => a.username) })
    }
  }
  return toPublic(s)
}

// ------------------------- Обработка кандидата -------------------------

type CandidateResult =
  | { ok: true; title: string; category: string; posts: number; members: number | null }
  | { ok: false; reason: string }

async function processCandidate(
  uname: string,
  s: InternalState,
  knownCats: Map<string, string>,
  otherId: string | undefined,
  // v5.76: жёсткая категория из кураторского каталога (нейро-уточнение пропускается)
  forcedSlug?: string,
): Promise<CandidateResult> {
  // 1) веб-превью: должно отвечать и содержать посты
  let html: string
  try {
    const res = await fetch(`https://t.me/s/${uname}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'ru,en;q=0.9',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
    html = await res.text()
  } catch {
    return { ok: false, reason: 't.me недоступен/таймаут' }
  }

  const posts = parseChannelHtml(html, uname)
  if (posts.length === 0) return { ok: false, reason: 'нет веб-превью или постов' }

  // 2) метаданные: og:title/og:description из страницы + Bot API getChat
  const ogTitle = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] ?? ''
  const ogDesc = html.match(/<meta property="og:description" content="([^"]*)"/)?.[1] ?? ''
  const chat = await getChatInfo(unate(uname))
  const title = decodeEnt(chat?.title ?? ogTitle) || uname
  const description = chat?.description ? decodeEnt(chat.description) : decodeEnt(ogDesc) || null
  const hint = `${title} ${description ?? ''}`

  // v5.77: только русские каналы — в названии/описании должна быть кириллица.
  // v5.78: og-мета часто на латинице даже у русских каналов («Gamebomb», «CS2»,
  // «hearthstone») — тогда решает проверка ТЕКСТОВ постов: ≥ половина из первых
  // содержательных постов русские (isRussianText: ≥30% кириллицы) → канал русский.
  if (!/[\p{Script=Cyrillic}]{3,}/u.test(hint)) {
    const texts = posts
      .slice(0, 8)
      .map((p) => p.text.trim())
      .filter((t) => t.length >= 10)
      .slice(0, 6)
    const ruPosts = texts.filter((t) => isRussianText(t)).length
    if (texts.length === 0 || ruPosts < Math.ceil(texts.length / 2)) {
      return { ok: false, reason: 'не русский канал' }
    }
  }

  const slug = forcedSlug ?? classifyCategory(hint)
  // v5.77: GAMES-ONLY режим — автосбор пропускает не-игровые каналы
  // (кураторский каталог с forcedSlug не проверяем — он сам по себе игровой)
  if (!forcedSlug) {
    const only = await getOnlySlug()
    if (only && slug !== only) {
      return { ok: false, reason: `не ${only} (${slug})` }
    }
  }
  const categoryId = forcedSlug ? knownCats.get(forcedSlug) : (knownCats.get(slug) ?? otherId)

  // 3) число подписчиков (дешёвый вызов, кэш 24ч) — заодно фильтр качества:
  //    каналы-пустышки размывают ленту и убивают конверсию рекламы
  const members = await getChatMemberCount(unate(uname))
  if (members != null && members < MIN_MEMBERS) {
    return { ok: false, reason: `мало подписчиков (${members})` }
  }

  // 4) создание канала
  const colors = ['#3390ec', '#00897b', '#6f4dbf', '#e0533d', '#d81b60', '#2e7d32', '#f7931a', '#546e7a']
  let colorIdx = 0
  for (let i = 0; i < uname.length; i++) colorIdx = (colorIdx * 31 + uname.charCodeAt(i)) >>> 0

  let channel
  try {
    channel = await db.channel.create({
      data: {
        tgId: chat?.id ?? `disc_${uname}`,
        title,
        username: uname,
        description,
        avatarColor: colors[colorIdx % colors.length],
        categoryId: categoryId ?? otherId ?? '',
        status: 'active',
        ...(chat?.photoFileId
          ? { photoFileId: chat.photoFileId, avatarFetchedAt: new Date() }
          : {}),
        ...(members != null ? { membersCount: members, membersFetchedAt: new Date() } : {}),
      },
      select: { id: true },
    })
  } catch {
    return { ok: false, reason: 'уже существует (гонка) или ошибка БД' }
  }

  // 5) посты первой страницы (новейшие до POSTS_PER_NEW_CHANNEL)
  //    v5.77: УНИФИКАЦИЯ с основным парсером: премиум-эмодзи (ID + анимации),
  //    зачистка текста, русский фильтр, реакции — раньше автосбор сохранял
  //    «сырые» посты без эмодзи-апгрейда и мусора
  const upgraded = await upgradeCustomEmoji([...posts])
  const queue = [...upgraded]
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
    .slice(0, POSTS_PER_NEW_CHANNEL)
  let addedPosts = 0
  for (const p of queue) {
    if (!isRussianText(p.text)) continue // только русские посты
    try {
      const primary = p.media
      const extras = primary
        ? (({ url: _u, kind: _k, ...rest }) => (Object.keys(rest).length > 0 ? rest : null))(primary)
        : null
      const clean = cleanPostText(p.text)
      if (!clean && !primary && p.gallery.length === 0) continue
      await db.post.create({
        data: {
          tgKey: p.tgKey,
          channelId: channel.id,
          text: clean,
          mediaUrl: primary?.url ?? null,
          mediaType: primary?.kind ?? 'none',
          mediaMeta: extras ? JSON.stringify(extras) : null,
          gallery: p.gallery.length > 0 ? JSON.stringify(p.gallery) : null,
          viewsTg: p.viewsTg,
          reactionsTg: p.reactionsTg,
          link: `https://t.me/${p.tgKey.replace(':', '/')}`,
          publishedAt: p.publishedAt,
        },
        select: { id: true },
      })
      addedPosts++
    } catch {
      // дубликат — пропускаем
    }
  }

  // 6) кандидаты для обхода графа: ссылки t.me/<name> и @mentions
  const found = extractCandidates(html)
  for (const c of found) {
    if (s.queue.length >= QUEUE_CAP) break
    if (!s.visited.includes(c) && !s.queue.some((q) => q.toLowerCase() === c)) s.queue.push(c)
  }

  // 7) уточнение категории нейросетью (фон): регэксп-присвоение выше — лишь
  //    предварительное, LLM переоценивает канал по совокупности признаков.
  //    Для кураторских каналов категория ФИКСИРОВАННАЯ — уточнение пропускаем
  if (!forcedSlug) void refineChannelCategory(channel.id, title, uname, description)

  return { ok: true, title, category: slug, posts: addedPosts, members }
}

/**
 * v5.76: одиночное «живое» добавление канала из кураторского каталога.
 * Проверяет t.me/s (должен отвечать страницей с постами + ≥100 подписчиков),
 * создаёт канал с ФИКСИРОВАННОЙ категорией (нейро-уточнение не вызывается)
 * и сразу парсит первую страницу постов (~25). Мёртвый юзернейм возвращает
 * ok:false — канал НЕ создаётся, каталог остаётся чистым.
 */
export async function discoverSingleChannel(
  rawUsername: string,
  slug: string,
): Promise<
  | { ok: true; title: string; posts: number; members: number | null }
  | { ok: false; reason: string }
> {
  const uname = rawUsername.replace(/^@/, '').trim().toLowerCase()
  if (!/^[a-z][a-z0-9_]{3,31}$/.test(uname)) return { ok: false, reason: 'некорректный username' }
  const cats = await db.category.findMany({ select: { id: true, slug: true } })
  const knownCats = new Map(cats.map((c) => [c.slug, c.id]))
  if (!knownCats.has(slug)) return { ok: false, reason: `нет категории ${slug}` }
  const otherId = knownCats.get('other') ?? [...knownCats.values()][0]
  // Стуб состояния: processCandidate использует только queue/visited для
  // кандидатов «графа» — одиночному добавлению они не нужны
  const stubState = { queue: [] as string[], visited: [] as string[] } as unknown as InternalState
  const res = await processCandidate(uname, stubState, knownCats, otherId, slug)
  if (!res.ok) return res
  return { ok: true, title: res.title, posts: res.posts, members: res.members }
}

/**
 * Фоновое уточнение категории канала нейросетью (gemini-flash-lite, копейки).
 * Ошибки тихо проглатываются: остаётся регэксп-категория.
 */
async function refineChannelCategory(
  channelId: string,
  title: string,
  username: string,
  description: string | null,
): Promise<void> {
  try {
    const [cats, channel] = await Promise.all([
      db.category.findMany({ select: { id: true, slug: true, title: true } }),
      db.channel.findUnique({ where: { id: channelId }, select: { categoryId: true } }),
    ])
    if (!channel) return
    const map = await classifyChannelsBatch([{ id: channelId, title, username, description }], cats)
    let slug = map.get(channelId)
    if (!slug) return
    // v5.77: GAMES-ONLY — нейро-уточнение не уводит канал из целевой категории
    const only = await getOnlySlug()
    if (only && slug !== only) slug = only
    const cat = cats.find((c) => c.slug === slug)
    if (!cat || cat.id === channel.categoryId) return
    await db.channel.update({ where: { id: channelId }, data: { categoryId: cat.id } })
    // Категория влияет на ленту/каталог — сбрасываем кэши
    await bumpCache(['feed', 'tr', 'ch', 'ct']).catch(() => {})
  } catch {
    // фон: не критично
  }
}

/** нормализация username перед Bot API (защита от подстановки) */
function unate(u: string): string {
  return u.replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '')
}

/** Вытащить кандидатов-каналов из HTML превью */
function extractCandidates(html: string): string[] {
  const out = new Set<string>()
  const re = /t\.me\/(?:s\/)?([A-Za-z][A-Za-z0-9_]{3,31})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const u = m[1]
    const lower = u.toLowerCase()
    if (TG_SERVICE_PATHS.has(lower)) continue
    if (/bot$/i.test(u)) continue
    out.add(u)
  }
  const reMention = /@([A-Za-z][A-Za-z0-9_]{4,31})(?![\w@])/g
  while ((m = reMention.exec(html)) !== null) {
    const u = m[1]
    if (TG_SERVICE_PATHS.has(u.toLowerCase())) continue
    if (/bot$/i.test(u)) continue
    out.add(u)
  }
  return [...out]
}

/** decodeEntities локально: og-теги приходят с &amp; и &quot; */
function decodeEnt(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()
}
