'use client'

/**
 * Копирование в буфер обмена с фолбэком.
 *
 * navigator.clipboard доступен только в secure context и может быть ОТКЛОНЁН
 * политикой разрешений: в Telegram Web миниапп работает в кросс-доменном
 * iframe, и Chrome по умолчанию не выдаёт там clipboard-write. Раньше кнопки
 * «Скопировать ссылку/текст» показывали «Не удалось скопировать», хотя
 * классический execCommand('copy') по пользовательскому клику срабатывает.
 * Фолбэк — скрытая textarea + execCommand (тот же приём уже применялся
 * точечно в PostOverlay/RichText — теперь единый хелпер).
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* политика разрешений/не secure context — пробуем фолбэк */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.left = '0'
    ta.style.opacity = '0'
    ta.style.pointerEvents = 'none'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
