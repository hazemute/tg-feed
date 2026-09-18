'use client'

/**
 * Клиент API локальной админ-панели /admin.
 * Обычный fetch с заголовком x-admin-key (НЕ src/lib/api.ts — тот про Telegram-сессии).
 * Ключ хранится в sessionStorage('tgfeed_admin_key'), при 401 — очищается,
 * страницу переводит на экран логина событие UNAUTH_EVENT.
 */

import { toast } from 'sonner'

/* ===================== Типы ответов панели ===================== */

export interface OverviewCounts {
  users: number
  usersTelegram: number
  usersGuest: number
  channelsActive: number
  channelsModeration: number
  channelsRejected: number
  posts: number
  ads: number
  likes: number
  subscriptions: number
  bookmarks: number
  hashtagClicks24h: number
}

export interface OverviewNotif {
  botConfigured: boolean
  sent24h: number
}

export interface FreshPost {
  id: string
  channelTitle: string
  channelUsername: string
  avatarColor: string
  avatarUrl?: string | null
  text: string
  publishedAt: string
  mediaUrl: string | null
}

export interface RecentUser {
  id: string
  username: string
  firstName: string
  isGuest: boolean
  createdAt: string
}

export interface TopChannel {
  title: string
  username: string
  avatarColor: string
  avatarUrl?: string | null
  subscribersCount: number
  postsCount: number
}

export interface Overview {
  counts: OverviewCounts
  deltas24h: {
    users: number
    posts: number
    likes: number
    views: number
    subscriptions: number
  }
  postsPerDay: number[]
  notif: OverviewNotif
  freshPosts: FreshPost[]
  recentUsers: RecentUser[]
  topChannels: TopChannel[]
}

export type ChannelStatus = 'active' | 'moderation' | 'rejected'
export type ChannelStatusFilter = 'all' | ChannelStatus

export interface PanelChannel {
  id: string
  title: string
  username: string
  description: string
  avatarColor: string
  avatarUrl?: string | null
  status: ChannelStatus
  isPremium: boolean
  categoryId: string | null
  categoryTitle: string | null
  subscribersCount: number
  clicksCount: number
  postsCount: number
  createdAt: string
}

export interface ChannelsResponse {
  items: PanelChannel[]
  total: number
  page: number
  pageSize: number
}

export interface ModerationItem {
  id: string
  title: string
  username: string
  description: string
  avatarColor: string
  avatarUrl?: string | null
  categoryTitle: string | null
  postsCount: number
  createdAt: string
}

export interface ModerationResponse {
  items: ModerationItem[]
}

export interface PanelUser {
  id: string
  username: string
  firstName: string
  lastName: string
  isGuest: boolean
  isPremium?: boolean
  bypassMaintenance: boolean
  createdAt: string
  likes: number
  subscriptions: number
  bookmarks: number
  views: number
}

export interface UsersResponse {
  items: PanelUser[]
  total: number
  page: number
  pageSize: number
}

export interface Ad {
  id: string
  title: string
  body: string
  ctaLabel: string
  link: string
  imageUrl: string
  isActive: boolean
  createdAt: string
  impressions: number
  clicks: number
  impressions24h: number
  clicks24h: number
}

/** CPA-кампания пользователя (создаётся в мини-аппе через «Продвинуть в Топ») */
export interface AdCampaign {
  id: string
  title: string
  body: string
  ctaLabel: string
  link: string
  imageUrl: string | null
  isActive: boolean
  status: string
  budgetKop: number
  spentKop: number
  impressions: number
  clicks: number
  createdAt: string
  owner: { username: string | null; firstName: string | null } | null
}

export interface AdsResponse {
  items: Ad[]
  campaigns?: AdCampaign[]
}

export interface AdMutationResponse {
  ok: boolean
  ad?: Ad
  campaign?: AdCampaign
}

export interface PanelHealthEnv {
  nodeEnv: string
  cronSecretSet: boolean
  adminKeySet: boolean
  botTokenSet: boolean
  dbProvider: string
}

export interface PanelHealth {
  ok: boolean
  db: boolean
  bot: boolean
  botUsername: string | null
  session: string
  version: string
  uptimeSec: number
  time: string
  /** Глобальная пауза Bot API после 429 (сек до снятия; 0 — нет) */
  botBanSec?: number
  /** Активные каналы без карточки (подписчики/аватар) — прогресс бэкфилла */
  channelsMissingCards?: number
  channelsTotal?: number
  env: PanelHealthEnv
}

export interface ParseResultRow {
  username: string
  added: number
  error?: string
}

export interface ParseResult {
  ok: boolean
  results: ParseResultRow[]
  newPostsCount: number
  notified: { sent: number; failed: number; recipients: number }
  truncated?: boolean
  totalTargets?: number
}

export interface ToolsParseResponse {
  ok: boolean
  result: ParseResult
}

export interface AutodiscoverState {
  running: boolean
  phase: 'idle' | 'working' | 'done' | 'stopped'
  source: 'all' | 'tgstat' | 'combot' | 'curated'
  queueSize: number
  visitedCount: number
  processedCount: number
  channelsAdded: number
  postsAdded: number
  rejectedCount: number
  maxNew: number
  sourcesLeft: number
  added: Array<{ username: string; title: string; category: string; posts: number; members: number | null }>
  rejected: Array<{ username: string; reason: string }>
  log: Array<{ at: number; msg: string }>
  startedAt: number
  updatedAt: number
}

export interface AutoparseResponse {
  ok: boolean
  state: AutodiscoverState | null
}

export interface LoginResponse {
  ok: boolean
  version: string
}

export interface SystemInfo {
  maintenance: {
    enabled: boolean
    dbMirror: boolean
  }
  admins: string[]
  allow: {
    users: Array<{
      id: string
      username: string | null
      firstName: string | null
      lastName: string | null
      isGuest: boolean
      bypassMaintenance: boolean
    }>
    pendingIds: string[]
  }
  cache: {
    redis: 'upstash' | 'memory-only' | 'down'
    versions: Record<string, number>
  }
}

/* ===================== Ключ администратора ===================== */

const KEY_STORAGE = 'tgfeed_admin_key'

/** Событие в window: любой запрос вернул 401 — ключ сброшен, показать логин. */
export const UNAUTH_EVENT = 'tgfeed-admin-401'

export function getAdminKey(): string | null {
  try {
    return sessionStorage.getItem(KEY_STORAGE)
  } catch {
    return null
  }
}

export function setAdminKey(key: string): void {
  try {
    sessionStorage.setItem(KEY_STORAGE, key)
  } catch {
    /* приватный режим — ключ живёт только в памяти вкладки */
  }
}

export function clearAdminKey(): void {
  try {
    sessionStorage.removeItem(KEY_STORAGE)
  } catch {
    /* noop */
  }
}

/* ===================== fetch-обёртка ===================== */

export class PanelError extends Error {
  status: number
  retryAfter: number | null

  constructor(message: string, status: number, retryAfter: number | null = null) {
    super(message)
    this.name = 'PanelError'
    this.status = status
    this.retryAfter = retryAfter
  }
}

export interface PanelFetchInit {
  method?: string
  json?: unknown
}

export function isAuthOrNetworkError(e: unknown): boolean {
  return e instanceof PanelError && (e.status === 401 || e.status === 0)
}

export async function panelFetch<T>(path: string, init?: PanelFetchInit): Promise<T> {
  const headers: Record<string, string> = {}
  const key = getAdminKey()
  if (key) headers['x-admin-key'] = key

  let res: Response
  try {
    res = await fetch(path, {
      method: init?.method ?? (init?.json !== undefined ? 'POST' : 'GET'),
      headers:
        init?.json !== undefined ? { ...headers, 'Content-Type': 'application/json' } : headers,
      body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
      cache: 'no-store',
    })
  } catch {
    toast.error('Сеть недоступна')
    throw new PanelError('Сеть недоступна', 0)
  }

  if (res.status === 401) {
    clearAdminKey()
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(UNAUTH_EVENT))
    throw new PanelError('Требуется авторизация', 401)
  }

  if (res.status === 429) {
    const raw = res.headers.get('Retry-After')
    const parsed = raw === null ? Number.NaN : Number(raw)
    throw new PanelError('Слишком часто', 429, Number.isFinite(parsed) ? parsed : null)
  }

  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }

  if (!res.ok) {
    const msg =
      data !== null &&
      typeof data === 'object' &&
      'error' in data &&
      typeof (data as { error: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `Ошибка ${res.status}`
    throw new PanelError(msg, res.status)
  }

  return data as T
}

/* ===================== Форматирование ===================== */

/** «только что / Nмин / Nч / Nд / дд.мм» */
export function fmtAgo(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return '—'
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 60) return 'только что'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}мин`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}ч`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}д`
  const date = new Date(t)
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}`
}

/** «1 234 / 48,2K / 1,2M» */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n >= 1_000_000) {
    const v = n / 1_000_000
    const s = v >= 100 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toString()
    return `${s.replace('.', ',')}M`
  }
  if (n >= 10_000) {
    const v = n / 1_000
    const s = v >= 100 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toString()
    return `${s.replace('.', ',')}K`
  }
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/** «2д 3ч 5м» из секунд */
export function fmtUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const parts: string[] = []
  if (d > 0) parts.push(`${d}д`)
  if (h > 0) parts.push(`${h}ч`)
  parts.push(`${m}м`)
  return parts.join(' ')
}
