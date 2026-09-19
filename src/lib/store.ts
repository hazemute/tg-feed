'use client'

import { create } from 'zustand'
import type { CategoryDTO, FontScale, PostDTO, Tab, ThemeMode, UserDTO } from '@/lib/types'
import type { Lang } from '@/lib/i18n'

interface AppState {
  user: UserDTO | null
  authReady: boolean
  tab: Tab
  tabDir: number // направление анимации перехода вкладок (-1 | 1)
  category: string // slug | 'all'
  categories: CategoryDTO[]
  interests: string[]
  feedVersion: number
  theme: ThemeMode
  fontScale: FontScale
  lang: Lang
  setLang: (l: Lang) => void
  channelUsername: string | null // открытый экран канала (внутренний)
  post: PostDTO | null // открытый полный экран поста (внутренний)
  postQueue: PostDTO[] // снимок списка постов вокруг открытого — для свайпов ←/→ в полном экране
  searchSeed: string | null // внешний поисковый запрос (тап по хэштегу в ленте); null — запроса нет
  maintenance: boolean // включён режим техработ и пользователь без допуска
  setMaintenance: (v: boolean) => void
  /* Ленивая регистрация: гость свободно читает/свайпает, но лайк/закладка
   * открывают шторку «привяжи Telegram за 2 секунды» (authGate) и,
   * по кнопке, шит входа (loginOpen) — глобально, чтобы открываться
   * из любого места (лента, оверлей, экран канала). */
  authGate: string | null // что хотел сделать гость: 'like' | 'bookmark' | 'comment' | null (null — закрыто)
  openAuthGate: (action: string) => void
  closeAuthGate: () => void
  loginOpen: boolean // шит «Вход по Telegram» (глобальный)
  setLoginOpen: (v: boolean) => void
  commentsPost: PostDTO | null // открытый экран комментариев (глобально — из ленты и оверлея)
  openComments: (post: PostDTO) => void
  /** Открыть комментарии по id поста (из уведомлений: пост не загружен — создаём заглушку) */
  openCommentsById: (postId: string, commentsCount?: number) => void
  closeComments: () => void
  patchCommentsPost: (postId: string, commentsCount: number) => void
  shareSheetPost: PostDTO | null // пост для шита «Поделиться» (не сбрасывается при закрытии — нужна анимация выхода)
  shareSheetOpen: boolean
  openShareSheet: (post: PostDTO) => void
  closeShareSheet: () => void
  setUser: (u: UserDTO | null) => void
  setAuthReady: (v: boolean) => void
  setTab: (t: Tab) => void
  goToTab: (t: Tab) => void
  setCategory: (c: string) => void
  setCategories: (c: CategoryDTO[]) => void
  setInterests: (i: string[]) => void
  bumpFeed: () => void
  setTheme: (t: ThemeMode) => void
  setFontScale: (f: FontScale) => void
  openChannel: (username: string) => void
  closeChannel: () => void
  setPostQueue: (list: PostDTO[]) => void
  openPost: (post: PostDTO) => void
  closePost: () => void
  openSearchWith: (query: string) => void
  clearSearchSeed: () => void
}

const TAB_ORDER: Tab[] = ['feed', 'trending', 'search', 'profile']

export const useApp = create<AppState>((set, get) => ({
  user: null,
  authReady: false,
  tab: 'feed',
  tabDir: 1,
  category: 'all',
  categories: [],
  interests: [],
  feedVersion: 0,
  theme: 'light',
  fontScale: 'md',
  lang: 'ru',
  setLang: (lang) => {
    try {
      localStorage.setItem('tgfeed_lang', lang)
    } catch {}
    set({ lang })
  },
  channelUsername: null,
  post: null,
  postQueue: [],
  searchSeed: null,
  maintenance: false,
  setMaintenance: (maintenance) => set({ maintenance }),
  authGate: null,
  openAuthGate: (action) => set({ authGate: action }),
  closeAuthGate: () => set({ authGate: null }),
  loginOpen: false,
  setLoginOpen: (loginOpen) => set({ loginOpen }),
  commentsPost: null,
  openComments: (post) => set({ commentsPost: post }),
  // Экран комментариев использует только id/commentsCount поста — для перехода
  // из уведомлений достаточно заглушки (шит сам подтягивает список комментов)
  openCommentsById: (postId, commentsCount = 0) =>
    set((s) =>
      s.commentsPost?.id === postId
        ? s
        : {
            commentsPost: {
              id: postId,
              text: '',
              mediaUrl: null,
              mediaType: 'none',
              media: null,
              gallery: [],
              link: null,
              viewsCount: 0,
              viewsTg: null,
              likesCount: 0,
              bookmarksCount: 0,
              commentsCount,
              publishedAt: new Date().toISOString(),
              liked: false,
              bookmarked: false,
              channel: {
                id: '',
                title: '',
                username: '',
                description: null,
                avatarColor: '#3390ec',
                avatarUrl: null,
                subscribersCount: 0,
                isPremium: false,
                status: 'active',
                categorySlug: null,
                categoryTitle: null,
                subscribed: false,
                teaserMode: 'none',
                teaserLimit: 160,
              },
            } as PostDTO,
          },
    ),
  closeComments: () => set({ commentsPost: null }),
  // Счётчик после отправки/удаления: шит живёт снимком, поэтому патчим и снимок
  patchCommentsPost: (postId, commentsCount) =>
    set((s) =>
      s.commentsPost && s.commentsPost.id === postId
        ? { commentsPost: { ...s.commentsPost, commentsCount } }
        : s,
    ),
  shareSheetPost: null,
  shareSheetOpen: false,
  openShareSheet: (post) => set({ shareSheetPost: post, shareSheetOpen: true }),
  closeShareSheet: () => set({ shareSheetOpen: false }),
  setUser: (user) => set({ user, interests: user?.categories ?? [] }),
  setAuthReady: (authReady) => set({ authReady }),
  setTab: (tab) => set({ tab }),
  goToTab: (next) =>
    set((s) => {
      if (next === s.tab) return s
      const dir = Math.sign(TAB_ORDER.indexOf(next) - TAB_ORDER.indexOf(s.tab))
      return { tab: next, tabDir: dir !== 0 ? dir : 1 }
    }),
  setCategory: (category) => set({ category }),
  setCategories: (categories) => set({ categories }),
  setInterests: (interests) => set({ interests }),
  bumpFeed: () => set((s) => ({ feedVersion: s.feedVersion + 1 })),
  setTheme: (theme) => {
    try {
      localStorage.setItem('tgfeed_theme', theme)
    } catch {}
    set({ theme })
  },
  setFontScale: (fontScale) => {
    try {
      localStorage.setItem('tgfeed_font', fontScale)
    } catch {}
    set({ fontScale })
  },
  openChannel: (username) => set({ channelUsername: username.replace(/^@/, '') }),
  closeChannel: () => set({ channelUsername: null }),
  setPostQueue: (postQueue) => set({ postQueue }),
  // Полный экран поста («...еще» в ленте): храним снимок поста — оверлей рендерит
  // его мгновенно без запроса; лайки/закладки оверлей обновляет локально
  openPost: (post) => set({ post }),
  closePost: () => set({ post: null }),
  // Внешний запуск поиска (тап по хэштегу в ленте, «Открыть поиск» из пустой ленты):
  // кладём запрос в searchSeed и переходим на вкладку поиска через goToTab
  // (сохраняет направление анимации перехода; если уже на поиске — no-op).
  openSearchWith: (query) => {
    set({ searchSeed: query })
    get().goToTab('search')
  },
  // SearchTab сбрасывает seed после приёма, чтобы повторный тап того же тега сработал
  clearSearchSeed: () => set({ searchSeed: null }),
}))
