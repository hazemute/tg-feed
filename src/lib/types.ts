// Общие типы Tg Swipe (клиент + сервер)

export type CategoryDTO = {
  id: string
  slug: string
  title: string
  emoji?: string
  channelCount: number
  todayCount: number
}

export type ChannelDTO = {
  id: string
  title: string
  username: string
  description: string | null
  avatarColor: string
  /** Реальная аватарка (Bot API getChat → прокси /api/avatar/c_<id>); null → инициалы */
  avatarUrl?: string | null
  subscribersCount: number
  isPremium: boolean
  /** Официальный канал — синяя галочка (как в Telegram), ставится вручную в админке */
  verified?: boolean
  status: string
  categorySlug: string | null
  categoryTitle: string | null
  postsCount?: number
  subscribed: boolean
  /** Тизер-режим канала («Мой канал»): none | cut | blur */
  teaserMode: string
  /** Сколько символов показывать в режиме cut */
  teaserLimit: number
  /** v5.70: кому из постов применять тизер: all | long (лонгриды 600+ симв.) | text (без медиа) */
  teaserApplyTo?: 'all' | 'long' | 'text'
  /** Владелец канала с активным тиром Snap Pro (бейдж Premium-автора) */
  proOwner?: boolean
  /** CTA-кнопка Pro-автора в раскрытом посте (текст + https-ссылка) */
  ctaLabel?: string | null
  ctaUrl?: string | null
  /** v6.1: цена платной подписки на канал за месяц (null/undefined — выключена) */
  membershipPriceKop?: number | null
  /** v6.1: буст каталога активен (канал пиннится в топ каталога) */
  boosted?: boolean
}

export type SubscriptionDTO = {
  channelId: string
  hidden: boolean
  /** Колокольчик уведомлений: true — звук включён, false — тихо */
  notify?: boolean
  channel: ChannelDTO
}

export type MediaKind =
  | 'image'
  | 'video'
  | 'circle' // v5.77: кружок (video note) — круглый виджет как в Telegram
  | 'gif'
  | 'sticker'
  | 'voice'
  | 'audio'
  | 'file'
  | 'poll'
  | 'link'
  | 'none'

/** Элемент медиа поста (основной или в галерее) — экран/данные с парсера */
export type MediaItemDTO = {
  kind: MediaKind
  url?: string
  poster?: string
  /** Спойлер-медиа (заблюрено в Telegram) — раскрывается тапом */
  spoiler?: boolean
  name?: string
  size?: string
  title?: string
  performer?: string
  question?: string
  answers?: string[]
  site?: string
  description?: string
  link?: string
  /** v5.77: реальные размеры медиа из t.me/s — честный aspect-ratio без деформации */
  width?: number
  height?: number
  /** v5.77: длительность видео/кружка (сек) */
  duration?: number
}

export type PostDTO = {
  id: string
  text: string
  mediaUrl: string | null
  mediaType: string // 'image' | 'video' | 'gif' | 'sticker' | 'voice' | 'audio' | 'file' | 'poll' | 'link' | 'none'
  /** Основное медиа (kind + url + доп. атрибуты из mediaMeta) */
  media: MediaItemDTO | null
  /** Дополнительные медиа (карусель фото/видео, карточки файлов и т.д.) */
  gallery: MediaItemDTO[]
  link: string | null
  /** Просмотры для показа: приоритет у оригинального канала Telegram */
  viewsCount: number
  /** Просмотры из оригинального канала (t.me/s); null — нет данных */
  viewsTg: number | null
  likesCount: number
  bookmarksCount: number
  /** Локальные комментарии миниаппа (только привязанные к Telegram) */
  commentsCount: number
  publishedAt: string
  liked: boolean
  bookmarked: boolean
  /** Спонсорский пост (активная CPA-кампания) — показывается с бейджем «Реклама» */
  sponsored?: boolean
  /** Промо-пост (Snap Pro «Продвинуть в ленте») — в первых рядах с подсветкой */
  promoted?: boolean
  /** v6.1: пост только для платных подписчиков канала */
  memberOnly?: boolean
  /** v6.1: у текущего юзера активная платная подписка на канал (замок снят) */
  memberUnlocked?: boolean
  channel: ChannelDTO
}

/** Автор комментария (без приватных полей: только публичное представление) */
export type CommentAuthorDTO = {
  id: string
  name: string // «Имя Фамилия» или @username, или нейтральный фолбэк
  username: string | null
  avatarUrl: string | null
  /** v5.19: бейджи автора (developer/manager/…) — рендерятся у имени */
  badges?: string[]
}

export type CommentDTO = {
  id: string
  postId: string
  text: string
  createdAt: string
  author: CommentAuthorDTO
  /** true — комментарий текущей сессии (можно удалить) */
  own: boolean
  /** Дерево «как в TikTok»: null — корень; иначе id корневого комментария */
  parentId: string | null
  /** Плашка «Ответ NAME» внутри ветки (ответ на ответ) */
  replyToName: string | null
  /** Лайки комментария (денормализованный счётчик) */
  likesCount: number
  /** Лайкнут текущим пользователем */
  likedByMe: boolean
  /** Сколько ответов в ветке (для корня) */
  repliesCount: number
  /** v5.68: комментарий скрыт модерацией/жалобами (видит только автор — с плашкой) */
  hidden?: boolean
  /** v5.68: эвристическая оценка «похоже на рекламу» (0..100) */
  adScore?: number
  /** Превью/подгруженные ответы ветки (только у корней) */
  replies?: CommentDTO[]
}

export type AdDTO = {
  id: string
  /** kind='campaign' — CPA-кампания пользователя (биллинг за клик) */
  kind: 'ad' | 'campaign'
  title: string
  body: string
  ctaLabel: string
  link: string
  imageUrl: string | null
}

/** CPA-кампания рекламодателя (список в «Мой канал») */
export type CampaignDTO = {
  id: string
  title: string
  body: string
  ctaLabel: string
  link: string
  imageUrl: string | null
  costPerClickKop: number
  budgetKop: number
  spentKop: number
  impressions: number
  clicks: number
  rawClicks: number
  status: string
  note: string | null
  createdAt: string
}

/** Эскроу-счёт рекламодателя (копейки) */
export type AdvertiserDTO = {
  balanceKop: number
  topupsTotalKop: number
  spentTotalKop: number
}

/** Канал «Мой канал» со статистикой и кампаниями */
export type MyChannelDTO = {
  id: string
  title: string
  username: string
  description: string | null
  avatarColor: string
  avatarUrl: string | null
  subscribersCount: number
  status: string
  categorySlug: string
  categoryTitle: string
  teaserMode: string
  teaserLimit: number
  /** v5.70: гибкий показ в ленте — каким постам применять тизер (вкладка «Промо») */
  teaserApplyTo: 'all' | 'long' | 'text'
  /** CTA-кнопка в конце раскрытых постов (Snap Pro) */
  ctaLabel: string | null
  ctaUrl: string | null
  /** Когда ИИ-ассистент анализировал стиль канала (ISO, null — ещё не анализировал) */
  styleAt: string | null
  /** v6.1: монетизация владельца — верификация (админская/платная), буст, платная подписка */
  verifiedAdmin?: boolean
  verified?: boolean
  verifiedUntil?: string | null
  boostActive?: boolean
  boostUntil?: string | null
  membershipPriceKop?: number | null
  memberBenefits?: string | null
  stats: {
    posts: number
    views24h: number
    likes: number
    bookmarks: number
    lastPostAt: string | null
  }
  campaigns: CampaignDTO[]
}

/** Ответ GET /api/mychannel */
export type MyChannelResponse = {
  channels: MyChannelDTO[]
  advertiser: AdvertiserDTO
  /** v5.80: юзернейм бота — для deep link «Добавить бота в канал» (привязка) */
  botUsername?: string | null
  /** Тариф владельца канала (учитывает срок подписки) */
  tier: 'free' | 'plus' | 'pro'
  /** Продвижение в ленте (Snap Pro): использовано бесплатных за текущий месяц + кредиты пакета */
  promotion: { used: number; limit: number; available: boolean; credits: number }
  /** v5.69: плоские поля продвижения — использовано/лимит за календарный месяц (UTC) */
  promoteMonthlyUsed: number
  promoteMonthlyLimit: number
  /** Купленные продвижения (пакет), тратятся после бесплатного месячного */
  promoteCredits: number
  /** Цена пакета продвижений в копейках (PROMOTE_PACK.priceKop) */
  promotePackPrice: number
  /** Сколько продвижений в пакете (PROMOTE_PACK.count) */
  promotePackCount: number
  /** Когда вернётся бесплатное продвижение (начало следующего месяца UTC, ISO) */
  promoteResetAt: string
  /** v5.74: активные продвижения — просмотры с запуска + статус гарантии результата */
  promotions?: Array<{
    postId: string
    promotedAt: string
    views: number
    target: number
    hoursLeft: number
    guarantee: 'pending' | 'met'
  }>
  /** v5.74: условия промо — гарантия 500 просмотров/48ч, окно возврата 60 минут */
  promoTerms?: { guaranteeViews: number; guaranteeHours: number; refundWindowMin: number }
}

/** Живая статистика площадки для шита продвижения (GET /api/ads/stats) */
export type AdsPlatformStats = {
  channels: number
  posts: number
  users: number
  views24h: number
  adsActive: number
}

export type UserDTO = {
  id: string
  username: string | null
  firstName: string | null
  lastName?: string | null
  photoUrl: string | null
  isGuest: boolean
  isPremium?: boolean
  languageCode?: string | null
  categories: string[]
  /** Тариф: free | plus (Snap Plus) | pro (Snap Pro) — активный (с учётом срока) */
  tier?: 'free' | 'plus' | 'pro'
  /** Срок действия оплаченного тира (ISO) */
  tierUntil?: string | null
  /** v5.19: бейджи (developer/manager/moderator/sponsor/vip/early) */
  badges?: string[]
  /** v5.27: дата регистрации — строка «В Tg Swipe с …» в шапке профиля */
  createdAt?: string
  /** v5.27: оформление профиля */
  style?: { palette: string; bg: string; frame: string }
  /** v5.75: опыт и уровень (прогресс-бар под ником) */
  xp?: number
  level?: number
  /** v5.85: онбординг (гайд/тутор) уже показан — серверная отметка,
   *  переживает очистку localStorage в Telegram-клиентах */
  onboarded?: boolean
}

/** Ответ GET /api/user/[uid] — публичный профиль (без приватных полей) */
export type PublicProfileResponse = {
  id: string
  name: string
  username: string | null
  photoUrl: string | null
  isPremium: boolean
  tier: 'free' | 'plus' | 'pro'
  badges: string[]
  memberSince: string // ISO createdAt
  stats: { comments: number; likesReceived: number }
  /** v5.75: уровень и XP — публично */
  xp: number
  level: number
  style: { palette: string; bg: string; frame: string }
}

/** Ответ GET /api/level — мой уровень (v5.75) */
export type LevelResponse = {
  isGuest: boolean
  xp: number
  level: number
  inLevelXp: number
  needXp: number
  levelStart: number
  levelEnd: number
  pct: number
  nextRewardSwipes: number
  today: { comment: number; commentCap: number; like: number; likeCap: number }
  history: { id: string; kind: string; amount: number; note: string | null; createdAt: string }[]
}

/** Ответ GET /api/tiers — состояние тарифа и лимита ИИ-поиска */
export type TiersResponse = {
  tier: 'free' | 'plus' | 'pro'
  tierUntil: string | null
  aiSearch: { used: number; limit: number; remaining: number | null }
  prices: Record<
    'plus' | 'pro',
    { monthKop: number; yearKop: number; monthStars: number; yearStars: number }
  >
  methods: { card: boolean; stars: boolean; ton: boolean; sbp: boolean }
  /** Кошелёк сессии (v5.39): когда рублей хватает на тариф — показываем «С баланса» */
  wallet?: { balanceKop: number; swipes: number } | null
  /** Реквизиты исполнителя для документов и оферты Platega (env) */
  legal: { name: string; inn: string; email: string }
}

/** Ответ POST /api/ai/search — умный поиск: ответ нейросети + посты-источники */
export type AiSearchResponse = {
  answer: string
  sources: PostDTO[]
  /** Осталось поисков сегодня (null — безлимит, plus/pro) */
  remaining: number | null
  cached?: boolean
}

/** Ответ POST /api/ai/assistant (action=generate) — черновик поста для канала */
export type AiAssistantDraft = {
  text: string
  imageUrl: string | null
  /** Проверка картинки не успела — URL можно показать, публикация проверит ещё раз */
  imagePending?: boolean
  styleAnalyzed?: boolean
}

export type FeedResponse = {
  items: PostDTO[]
  page: number
  hasMore: boolean
}

export type SearchResponse = {
  items: PostDTO[]
  query: string
  /** v5.91: каналы из БД по запросу (раньше вкладка «Каналы» видела только каталог) */
  channels?: ChannelDTO[]
  /** v5.91: offset следующей страницы постов (null — дальше ничего нет) */
  nextOffset?: number | null
}

export type SummaryResponse = {
  items: string[]
  cached: boolean
  tooShort?: boolean
  /** true — нейросеть была недоступна, выжимка собрана из первых предложений */
  fallback?: boolean
}

export type AdminStatsDTO = {
  channelId: string
  title: string
  username: string
  avatarColor: string
  avatarUrl?: string | null
  status: string
  isPremium: boolean
  posts: number
  views: number
  clicks: number
  ctr: number
}

export type ProfileResponse = {
  user: UserDTO
  stats: { likes: number; subscriptions: number; views: number; bookmarks: number }
}

export type ThemeMode =
  | 'auto'
  | 'light'
  | 'dark'
  | 'sepia'
  | 'sand'
  | 'rose'
  | 'mint'
  | 'lavender'
  | 'pearl'
  | 'lime'
  | 'honey'
  | 'coral'
  | 'mono'
  | 'forest'
  | 'ocean'
  | 'midnight'
  | 'plum'
  | 'coffee'
  | 'sunset'
  | 'emerald'
  | 'crimson'
  | 'aurora'
  | 'cherry'
  | 'custom' // v5.28: своя палитра (фон+акцент в localStorage, vars поверх data-theme)
export type FontScale = 'sm' | 'md' | 'lg'

/* v5.72: «Промо» вернулось разделом кабинета «Ваш канал» (ChannelTab) —
 * отдельной вкладки навбара больше нет */
export type Tab = 'feed' | 'quests' | 'channel' | 'search' | 'profile'

/** Один день статистики активности в профиле (мини-барчарт «Активность за 7 дней») */
export type ActivityDayDTO = {
  /** Локальная дата сервера (UTC) в формате YYYY-MM-DD */
  date: string
  /** Просмотры постов (PostView.createdAt за этот день) */
  views: number
  /** Прочитанные закладки (Bookmark.readAt за этот день) */
  reads: number
  /** Лайки (Like.createdAt за этот день) */
  likes: number
}

/** Канал в рельсе «Похожие каналы» внизу экрана канала (компактный DTO без id) */
export type RelatedChannelDTO = {
  username: string
  title: string
  /** Число подписчиков (короткое имя поля для компактного DTO рельса) */
  subscribers: number
  isPremium: boolean
  verified?: boolean
  avatarColor?: string
  avatarUrl?: string | null
  categorySlug: string | null
  subscribed: boolean
}

/** Ответ GET /api/channel/related — до limit похожих каналов той же категории */
export type RelatedChannelsResponse = {
  items: RelatedChannelDTO[]
}

/** Пост в топе кабинета канала (компактный DTO) */
export type TopPostDTO = {
  id: string
  text: string
  mediaUrl: string | null
  mediaType: string
  /** COALESCE(viewsTg, viewsCount) — приоритет у просмотров Telegram */
  views: number
  reactions: number
  publishedAt: string
  link: string | null
}

/** Статистика канала для кабинета (GET /api/channel/stats?username=...) */
export type ChannelStatsDTO = {
  posts: number
  /** Сумма просмотров всех постов (COALESCE(viewsTg, viewsCount)) */
  viewsTotal: number
  viewsAvg: number
  /** Медиана просмотров (PERCENTILE_CONT 0.5) — устойчива к выбросам */
  viewsMedian: number
  viewsMax: number
  reactionsTotal: number
  reactionsAvg: number
  /** ER: реакций на 100 просмотров */
  erPct: number
  /** Охват: средние просмотры поста / подписчики канала, % (null — нет данных) */
  reachPct: number | null
  /** Лайки внутри приложения (Like по постам канала) */
  likesTotal: number
  /** Открытия постов канала в приложении (PostView) */
  appViews: number
  textLenAvg: number
  withTextPct: number
  firstAt: string | null
  lastAt: string | null
  /** Дней с хотя бы одним постом за всю историю */
  activeDays: number
  /** Среднее число постов на активный день */
  postsPerDayAvg: number
  /** Средний интервал между постами, часов (null — постов < 2) */
  gapHoursAvg: number | null
  /** [{ type: image|video|none|..., count }] по убыванию */
  mediaMix: { type: string; count: number }[]
  /** 0=воскресенье … 6=суббота (EXTRACT DOW, UTC) */
  weekday: { dow: number; count: number; viewsAvg: number }[]
  /** 0..23 часов UTC */
  hours: { hour: number; count: number; viewsAvg: number }[]
  /** Лучшее время публикации (3ч-бин × день недели, ≥2 постов, max средних просмотров) */
  bestSlot: { dow: number; hour: number; viewsAvg: number; samples: number } | null
  /** Последние ≤40 постов хронологически: динамика просмотров/реакций */
  series: { date: string; views: number; reactions: number }[]
  /** 30 дней (включая нулевые): постов в день */
  cadence: { date: string; count: number }[]
  topByViews: TopPostDTO[]
  topByReactions: TopPostDTO[]
  membersCount: number | null
  subscribersCount: number
}

/** Ответ GET /api/profile/stats — активность за 7 дней + суммарные показатели */
export type ProfileStatsResponse = {
  /** Ровно 7 дней по возрастанию, последний — сегодня (UTC сервера) */
  days: ActivityDayDTO[]
  totals: {
    /** Сумма views по всем 7 дням */
    views: number
    /** Сумма reads по всем 7 дням */
    reads: number
    /** Сумма likes по всем 7 дням */
    likes: number
    /** Число активных подписок (Subscription) */
    channels: number
  }
}

/** Пост в группе уведомлений (компактный: превью текста без markdown-мусора) */
export type NotificationPostDTO = {
  id: string
  /** До 140 символов, markdown-разметка вычищена */
  textPreview: string
  mediaUrl: string | null
  publishedAt: string
}

/** Группа уведомлений: канал с числом новых постов (экран «Уведомления») */
export type NotificationGroupDTO = {
  username: string
  title: string
  isPremium: boolean
  avatarColor: string
  avatarUrl?: string | null
  categorySlug: string | null
  /** Число новых постов этого канала (= posts.length) */
  count: number
  /** Посты канала, publishedAt desc */
  posts: NotificationPostDTO[]
}

/** Уведомление-активность (инбокс): событие, привязанное к пользователю */
export type NotificationDTO = {
  id: string
  /** comment — новый комментарий под постом канала; reply — ответ на мой
   *  комментарий; comment_like — лайк моего комментария; support — ответ
   *  поддержки; campaign — статус рекламной кампании; system — прочее */
  type: 'comment' | 'reply' | 'comment_like' | 'support' | 'campaign' | 'system'
  title: string
  body: string | null
  /** Связанный пост (type=comment/reply/comment_like) — тап открывает комментарии */
  postId: string | null
  /** Конкретный комментарий — тап открывает комментарии, раскрывает ветку
   *  и скроллит экран к этому комментарию с подсветкой */
  commentId: string | null
  channelUsername: string | null
  read: boolean
  createdAt: string
}

/** Ответ GET /api/notifications — новые посты каналов с включённым колокольчиком + активность */
export type NotificationsResponse = {
  /** Суммарное число новых постов по всем группам */
  count: number
  /** Каналы: больше новых постов — выше, при равенстве — новее последний пост */
  groups: NotificationGroupDTO[]
  /** Нижняя граница окна «нового»: lastSeenNotifiedAt ?? now−48ч (ISO) */
  since: string
  /** Инбокс активности (последние события: комментарии/поддержка/кампании) */
  activity: NotificationDTO[]
  /** Непрочитанных событий активности */
  unreadActivity: number
}

/** Пульс сообщества за 24 часа (экран «Тренды») */
export type PulseDTO = {
  /** Новых постов за 24ч */
  posts: number
  /** Лайков поставлено за 24ч */
  likes: number
  /** Просмотров постов за 24ч */
  views: number
  /** Кликов по #хэштегам за 24ч */
  clicks: number
}

/** Хэштег в тренде: тег без решётки + число кликов за 72ч */
export type HashtagTrendDTO = {
  tag: string
  clicks: number
}

/** Ответ GET /api/trending — агрегат вкладки «Тренды» */
export type TrendingResponse = {
  pulse: PulseDTO
  hashtags: HashtagTrendDTO[]
  topPosts: PostDTO[]
  topChannels: ChannelDTO[]
}

/* ================= Лидерборды (v5.87) — не рублёвые ================= */

/** Раздел лидерборда: уровни/свайпы — за всё время; просмотры/лайки/комментарии — за 30 дней */
export type LbTab = 'level' | 'swipes' | 'views' | 'likes' | 'comments'

/** Строка таблицы лидерборда (только публичные данные участника) */
export type LbEntry = {
  rank: number
  uid: string
  name: string
  username: string | null
  photoUrl: string | null
  premium: boolean
  /** Уровень участника (для подписи под именем) */
  level: number | null
  /** Значение метрики: уровень / свайпы / просмотры / лайки / комментарии */
  value: number
  /** Подпись под значением (например «1 234 XP») */
  sub: string | null
}

/** Ответ GET /api/leaderboard?tab=… */
export type LeaderboardResponse = {
  tab: LbTab
  /** 'all' — за всё время, '30d' — за последние 30 дней */
  window: 'all' | '30d'
  top: LbEntry[]
  /** Моё место: rank null — вне топа; null целиком — гость/нет данных */
  me: { rank: number | null; value: number; level: number | null } | null
  guest: boolean
  /** v5.88: награды за активность (топ-3 по XP недели/месяца получают свайпы) */
  prizes: LbPrizes | null
  /** v5.93: соцдоказательство — новых читателей за 7 дней (0 при ошибке счёта) */
  newReaders?: number
}

/* ================= Награды лидербордов (v5.88) ================= */

/** Строка «итоги прошлой недели/месяца»: кто получил приз и сколько */
export type LbPrizeRow = {
  place: number
  uid: string
  name: string
  username: string | null
  photoUrl: string | null
  premium: boolean
  level: number | null
  /** Начислено свайпов */
  amount: number
}

/** Блок наград: суммы + живой топ текущих периодов + итоги прошлых */
export type LbPrizes = {
  weekKey: string
  monthKey: string
  weeklyAmount: number
  monthlyAmount: number
  /** Живой топ-3 по XP, набранному с начала текущей недели/месяца */
  liveWeek: LbEntry[]
  liveMonth: LbEntry[]
  /** Выплаты за последний завершившийся период */
  lastWeek: LbPrizeRow[]
  lastMonth: LbPrizeRow[]
}
