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
  verified: boolean
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

export interface CommentModItem {
  id: string
  text: string
  createdAt: string
  author: {
    id: string
    name: string
    username: string | null
    avatarUrl: string | null
    banned: boolean
  }
  post: {
    id: string
    excerpt: string
    commentsCount: number
    channelTitle: string
    channelUsername: string
  }
}

export interface CommentModResponse {
  items: CommentModItem[]
}

export interface PanelUser {
  id: string
  username: string
  firstName: string
  lastName: string
  isGuest: boolean
  isPremium?: boolean
  bypassMaintenance: boolean
  /** v5.11: бан и баланс свайпов (AdvertiserAccount.balanceKop / 100) */
  bannedAt?: string | null
  banReason?: string | null
  swipes?: number
  /** v5.18: подписка Snap (tier — действующий, истёкший приходит как 'free') */
  tier?: 'free' | 'plus' | 'pro'
  tierUntil?: string | null
  /** v5.19: бейджи (developer/manager/moderator/sponsor/vip/early) */
  badges?: string[]
  createdAt: string
  likes: number
  subscriptions: number
  bookmarks: number
  views: number
}

/** v5.18: фильтры списка пользователей */
export type UsersFilter = 'all' | 'tg' | 'guests' | 'banned' | 'plus' | 'pro' | 'paid' | 'expiring'

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
  release: {
    released: boolean
    dbMirror: boolean
  }
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
  /** Таймаут запроса в мс (модерация/парсер могут идти до минуты) */
  timeoutMs?: number
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
      ...(init?.timeoutMs ? { signal: AbortSignal.timeout(init.timeoutMs) } : {}),
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

/* ===================== Поддержка (чат с пользователями) ===================== */

export interface SupportUser {
  id: string
  username: string | null
  firstName: string | null
  lastName: string | null
  isGuest: boolean
  photoUrl?: string | null
}

export interface SupportMsg {
  id: string
  sender: 'user' | 'ai' | 'admin' | 'system'
  text: string
  images?: string[]
  createdAt: string
}

export interface SupportThreadItem {
  id: string
  status: 'ai' | 'human' | 'closed'
  /** v5.11: support — чат поддержки; feedback — предложка/баг */
  kind?: 'support' | 'feedback'
  /** Для feedback: idea | bug */
  topic?: string | null
  unreadAdmin: number
  unreadUser: number
  lastMessageAt: string
  createdAt: string
  user: SupportUser
  lastMessage: { sender: string; text: string; createdAt: string } | null
}

export interface SupportThreadFull extends Omit<SupportThreadItem, 'lastMessage'> {
  messages: SupportMsg[]
}

export async function fetchSupportThreads(unseenOnly = false, kind?: 'support' | 'feedback'): Promise<SupportThreadItem[]> {
  const params = new URLSearchParams()
  if (unseenOnly) params.set('unseen', '1')
  if (kind) params.set('kind', kind)
  const qs = params.toString()
  const data = await panelFetch<{ items: SupportThreadItem[] }>(`/api/panel/support${qs ? `?${qs}` : ''}`)
  return data.items
}

export async function fetchSupportThread(id: string): Promise<SupportThreadFull> {
  return panelFetch<SupportThreadFull>(`/api/panel/support/${id}`)
}

export async function replySupportThread(id: string, text: string): Promise<SupportMsg> {
  const data = await panelFetch<{ ok: boolean; message: SupportMsg }>(`/api/panel/support/${id}`, {
    method: 'POST',
    json: { text },
  })
  return data.message
}

export async function setSupportThreadStatus(id: string, status: 'ai' | 'human' | 'closed'): Promise<void> {
  await panelFetch<{ ok: boolean }>(`/api/panel/support/${id}`, {
    method: 'PATCH',
    json: { status },
  })
}

/** v5.11: действия модерации пользователя (бан/баланс/премиум) + v5.18 подписки + v5.19 бейджи */
export async function userAction(
  payload:
    | { action: 'ban'; userId: string; reason?: string }
    | { action: 'unban'; userId: string }
    | { action: 'swipes'; userId: string; swipes: number }
    | { action: 'premium'; userId: string }
    | { action: 'tier'; userId: string; tier: 'plus' | 'pro'; days: number; mode: 'grant' }
    | { action: 'tier'; userId: string; mode: 'revoke' }
    | { action: 'badge'; userId: string; badge: string; mode: 'grant' | 'revoke'; reason?: string },
): Promise<void> {
  await panelFetch<{ ok: boolean }>('/api/panel/users', {
    method: 'PATCH',
    json: payload,
  })
}

/* ===================== Подписки Snap Plus/Pro (v5.18) ===================== */

export interface SubscriptionsMetrics {
  activePlus: number
  activePro: number
  expiring3d: number
  expiring7d: number
  granted: number
  extended: number
  revoked: number
}

export interface SubscriberItem {
  id: string
  username: string | null
  firstName: string | null
  lastName: string | null
  isGuest: boolean
  tier: 'plus' | 'pro'
  tierUntil: string | null
  createdAt: string
}

export interface RecentTierPayment {
  userId: string
  username: string | null
  firstName: string | null
  lastName: string | null
  amountKop: number
  purpose: string
  createdAt: string
}

export interface SubscriptionsResponse {
  metrics: SubscriptionsMetrics
  items: SubscriberItem[]
  recentPayments: RecentTierPayment[]
  total: number
  page: number
  pageSize: number
}

export function fetchSubscriptions(params: { q?: string; page?: number; view?: 'active' | 'expiring' }): Promise<SubscriptionsResponse> {
  const sp = new URLSearchParams()
  if (params.q?.trim()) sp.set('q', params.q.trim())
  if (params.page && params.page > 1) sp.set('page', String(params.page))
  if (params.view === 'expiring') sp.set('view', 'expiring')
  const qs = sp.toString()
  return panelFetch<SubscriptionsResponse>(`/api/panel/subscriptions${qs ? `?${qs}` : ''}`)
}

/** Быстрая выдача подписки по ID или @username со вкладки «Подписки» */
export function grantSubscription(payload: {
  userId?: string
  handle?: string
  tier: 'plus' | 'pro'
  days: number
  reason?: string
}): Promise<{ ok: boolean; userId: string; tier: string; tierUntil: string | null }> {
  return panelFetch('/api/panel/subscriptions', { method: 'POST', json: payload })
}

/* ===================== Бейджи (v5.19) ===================== */

export interface BadgeHolder {
  id: string
  username: string | null
  firstName: string | null
  lastName: string | null
  isGuest: boolean
  isPremium: boolean
  badges: string[]
  tier: string
  tierUntil: string | null
  createdAt: string
}

export interface BadgeRecentOp {
  action: string
  target: string
  badge: string | null
  reason: string | null
  createdAt: string
}

export interface BadgesResponse {
  counts: Record<string, number>
  items: BadgeHolder[]
  recent: BadgeRecentOp[]
  total: number
  page: number
  pageSize: number
}

export function fetchBadges(params: { badge?: string; q?: string; page?: number }): Promise<BadgesResponse> {
  const sp = new URLSearchParams()
  if (params.badge) sp.set('badge', params.badge)
  if (params.q?.trim()) sp.set('q', params.q.trim())
  if (params.page && params.page > 1) sp.set('page', String(params.page))
  const qs = sp.toString()
  return panelFetch<BadgesResponse>(`/api/panel/badges${qs ? `?${qs}` : ''}`)
}

/** Выдать/снять бейдж по ID или @username (вкладка «Бейджи») */
export function badgeAction(payload: {
  userId?: string
  handle?: string
  badge: string
  mode: 'grant' | 'revoke'
  reason?: string
  notify?: boolean
}): Promise<{ ok: boolean; userId: string; badges: string[] }> {
  return panelFetch('/api/panel/badges', { method: 'POST', json: payload })
}

/* ===================== Журнал действий (v5.18) ===================== */

export interface AuditItem {
  id: string
  action: string
  target: string
  meta: Record<string, unknown> | null
  createdAt: string
}

export interface AuditResponse {
  items: AuditItem[]
  total: number
  page: number
  pageSize: number
  byAction: Record<string, number>
}

export type AuditGroup = 'all' | 'tier' | 'badges' | 'moderation' | 'users'

export function fetchAudit(group: AuditGroup, page = 1): Promise<AuditResponse> {
  return panelFetch<AuditResponse>(`/api/panel/audit?group=${group}&page=${page}`)
}

/* ===================== Финансы и вовлечённость ===================== */

export interface FinanceResponse {
  revenue: {
    totalKop: number
    paymentsCount: number
    byProvider: Array<{ provider: string; kop: number; count: number }>
    byDay: Array<{ day: string; kop: number; count: number }>
  }
  ads: { spentKop: number; campaigns: number }
  liabilities: { balanceKop: number; accounts: number }
  engagement: {
    dau: number
    wau: number
    mau: number
    newUsersByDay: Array<{ day: string; count: number }>
    likesByDay: Array<{ day: string; count: number }>
    commentsByDay: Array<{ day: string; count: number }>
  }
}

export function fetchFinance(): Promise<FinanceResponse> {
  return panelFetch<FinanceResponse>('/api/panel/finance')
}

/** Имя пользователя нити: «Имя @username» или «Гость abc123» */
export function supportUserName(u: SupportUser): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim()
  if (name) return name
  if (u.username) return `@${u.username}`
  if (u.isGuest) return `Гость · ${u.id.slice(0, 10)}`
  return u.id.slice(0, 14)
}

/* ===================== Быстрые операции и карточка юзера ===================== */

export type OpsAction =
  | { action: 'hide_channel'; username: string }
  | { action: 'show_channel'; username: string }
  | { action: 'refresh_card'; username: string }
  | { action: 'reclassify'; username: string }
  | { action: 'delete_post'; target: string }

export async function runOps(payload: OpsAction): Promise<string> {
  const data = await panelFetch<{ ok: boolean; message: string }>('/api/panel/ops', {
    method: 'POST',
    json: payload,
  })
  return data.message
}

export interface PanelUserInfo {
  user: {
    id: string
    username: string | null
    firstName: string | null
    lastName: string | null
    isGuest: boolean
    isPremium: boolean
    languageCode: string | null
    tier?: string | null
    tierUntil?: string | null
    createdAt: string
  }
  stats: { views: number; likes: number; bookmarks: number; subscriptions: number }
  subscriptions: Array<{ title: string; username: string; hidden: boolean; status: string }>
  threads: Array<{ id: string; status: string; lastMessageAt: string }>
}

export async function fetchUserInfo(userId: string): Promise<PanelUserInfo> {
  return panelFetch<PanelUserInfo>(`/api/panel/user-info?userId=${encodeURIComponent(userId)}`)
}
