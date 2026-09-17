// Общие типы TG-Feed (клиент + сервер)

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
}

export type SubscriptionDTO = {
  channelId: string
  hidden: boolean
  /** Колокольчик уведомлений: true — звук включён, false — тихо */
  notify?: boolean
  channel: ChannelDTO
}

export type PostDTO = {
  id: string
  text: string
  mediaUrl: string | null
  mediaType: 'image' | 'video'
  gallery: string[]
  link: string | null
  viewsCount: number
  likesCount: number
  bookmarksCount: number
  publishedAt: string
  liked: boolean
  bookmarked: boolean
  channel: ChannelDTO
}

export type AdDTO = {
  id: string
  title: string
  body: string
  ctaLabel: string
  link: string
  imageUrl: string | null
}

export type UserDTO = {
  id: string
  username: string | null
  firstName: string | null
  lastName?: string | null
  photoUrl: string | null
  isDemo: boolean
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
  | 'mono'
  | 'forest'
  | 'ocean'
  | 'midnight'
  | 'plum'
  | 'coffee'
  | 'sunset'
export type FontScale = 'sm' | 'md' | 'lg'

export type Tab = 'feed' | 'trending' | 'search' | 'profile'

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
