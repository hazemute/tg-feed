/**
 * v5.84 — управление загрузочной шторкой (boot shell), см. layout.tsx.
 *
 * Шторка — это script-созданный overlay, который красится и показывается
 * ДО гидрации: пока WebView не докачал/не запустил JS-чанки, пользователь
 * видит брендированный сплэш вместо пустого экрана (баг «серая пустота»
 * в Telegram Desktop при устаревшем кэше HTML → 404 чанков).
 *
 * Если React смонтировался — page.tsx вызывает hideBootShell() в первом
 * эффекте: шторка плавно гаснет и удаляется из DOM, вотчдоги отменяются.
 * Если React НЕ поднялся — вотчдоги внутри layout-скрипта сами показывают
 * «Перезагрузить» (чистый DOM, React не нужен).
 */
export function hideBootShell(): void {
  try {
    const w = window as Window & {
      __bootShell?: { hide: () => void }
      __bootShellTimers?: number[]
    }
    if (w.__bootShellTimers?.length) {
      for (const t of w.__bootShellTimers) clearTimeout(t)
      w.__bootShellTimers = []
    }
    w.__bootShell?.hide()
  } catch {
    /* шторка — UX-украшение: любая ошибка здесь не должна ронять приложение */
  }
}
