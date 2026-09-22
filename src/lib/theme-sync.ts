/**
 * Синк темы оформления между устройствами (v5.94).
 *
 * Источник истины — User.themeSettings на сервере (JSON {mode, custom}).
 * - Устройство А меняет тему/палитру → pushThemeSoon() (debounce 600мс, fire-and-forget).
 * - Устройство Б при входе (после auth) → pullServerTheme(): на сервере есть
 *   тема и она отличается от локальной → сервер главнее, локальная перезаписывается.
 * - На сервере ещё ничего нет (первый запуск после релиза) → устройство
 *   выгружает свой локальный выбор: ничего не теряется, база появляется сразу.
 * - Гости не синкают (нет общего профиля — синхронизировать не с чем).
 *
 * Эхо-защита: после pull/push запоминаем снапшот темы; собственное применение
 * удалённой темы не уходит обратно на сервер. До завершения первого pull
 * push-и молчат — иначе загрузочное состояние устройства затёрло бы сервер.
 *
 * Модуль клиентский (вызывается из page.tsx и ThemeGallery).
 */
import { useApp } from '@/lib/store'
import { api } from '@/lib/api'
import {
  isValidCustomTheme,
  loadCustomTheme,
  saveCustomTheme,
} from '@/lib/custom-theme'
import type { ThemeMode } from '@/lib/types'

type ServerThemeDTO = { mode: string | null; custom?: { bg: string; accent: string } | null }

let pullDone = false // первый pull завершён (успешно или нет) — после него можно push-ить
let pullInFlight: Promise<void> | null = null
let pushTimer: ReturnType<typeof setTimeout> | null = null
let lastSynced = ''

function isGuest(): boolean {
  const id = useApp.getState().user?.id
  return !id || id.startsWith('guest_')
}

/** Снимок «тема|палитра» — для сравнения и эхо-фильтра */
function snapshot(): string {
  const t = useApp.getState().theme
  const c = loadCustomTheme()
  return `${t}|${c ? `${c.bg}${c.accent}` : ''}`
}

/**
 * Потянуть тему с сервера (один раз за сессию, после авторизации).
 * Применение через saveCustomTheme + setTheme — existing эффекты page.tsx
 * сами перекрасят DOM/рамки (та же цепочка, что при ручной смене темы).
 */
export function pullServerTheme(): Promise<void> {
  if (pullInFlight) return pullInFlight
  pullInFlight = (async () => {
    try {
      if (isGuest()) return
      const r = await api<ServerThemeDTO>('/api/me/theme', { cache: 'no-store' })
      const mode = r?.mode
      if (!mode) {
        // на сервере пусто — выгружаем локальный выбор как начальную точку
        // (pushThemeSoon требует pullDone — снимаем флаг до вызова)
        pullDone = true
        pullInFlight = null
        pushThemeSoon()
        return
      }
      const remoteCustom = r.custom && isValidCustomTheme(r.custom) ? r.custom : null
      const sameMode = useApp.getState().theme === mode
      const local = loadCustomTheme()
      const sameCustom =
        mode !== 'custom' ||
        JSON.stringify(local ?? null) === JSON.stringify(remoteCustom ?? null)
      if (sameMode && sameCustom) {
        lastSynced = snapshot() // совпало — просто фиксируем, чтобы не эхить
        return
      }
      // сервер главнее: применяем удалённый выбор (localStorage + стор)
      if (mode === 'custom' && remoteCustom) {
        // диспатчит CUSTOM_THEME_EVENT — если тема уже custom, перекрасит сразу
        saveCustomTheme(remoteCustom)
      }
      if (!sameMode) useApp.getState().setTheme(mode as ThemeMode)
      lastSynced = snapshot()
    } catch {
      // нет сети / 401 — живём с локальной темой, ретраить нечего
    } finally {
      pullDone = true
      pullInFlight = null
    }
  })()
  return pullInFlight
}

/**
 * Отправить тему на сервер (debounce 600мс, fire-and-forget).
 * Вызывается при смене темы (эффект [theme] в page.tsx) и при правке
 * кастомной палитры (CUSTOM_THEME_EVENT). Вызов до завершения первого
 * pull игнорируется — иначе загрузочный localStorage затёр бы сервер.
 */
export function pushThemeSoon(): void {
  if (isGuest()) return
  if (!pullDone) return
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    pushTimer = null
    const snap = snapshot()
    if (snap === lastSynced) return // своё же применение удалённой темы — не эхим
    const t = useApp.getState().theme
    const custom = loadCustomTheme()
    lastSynced = snap
    void api('/api/me/theme', {
      method: 'PUT',
      body: JSON.stringify({ mode: t, custom: t === 'custom' ? custom : null }),
    }).catch(() => {
      // не ушло — сбрасываем снапшот, следующая правка повторит попытку
      lastSynced = ''
    })
  }, 600)
}
