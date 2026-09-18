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
  status: string
  categorySlug: string | null
  categoryTitle: string | null
  postsCount?: number
  subscribed: boolean
  /** Тизер-режим канала («Мой канал»): none | cut | blur */
  teaserMode: string
  /** Сколько символов показывать в режиме cut */
  teaserLimit: number
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
  publishedAt: string
  liked: boolean
  bookmarked: boolean
  /** Спонсорский пост (активная CPA-кампания) — показывается с бейджем «Реклама» */
  sponsored?: boolean
  channel: ChannelDTO
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
}

export type FeedResponse = {
  items: PostDTO[]
  page: number
  hasMore: boolean
}

export type SearchResponse = {
  items: PostDTO[]
  query: string
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
export type FontScale = 'sm' | 'md' | 'lg'

export type Tab = 'feed' | 'trending' | 'search' | 'mychannel' | 'profile'

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

/** Ответ GET /api/notifications — новые посты каналов с включённым колокольчиком */
export type NotificationsResponse = {
  /** Суммарное число новых постов по всем группам */
  count: number
  /** Каналы: больше новых постов — выше, при равенстве — новее последний пост */
  groups: NotificationGroupDTO[]
  /** Нижняя граница окна «нового»: lastSeenNotifiedAt ?? now−48ч (ISO) */
  since: string
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
