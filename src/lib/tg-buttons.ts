/**
 * КНОПКИ БОТА: ПРЕМИУМ-ИКОНКИ + ЦВЕТНЫЕ СТИЛИ (v5.29, официальный Bot API).
 *
 * InlineKeyboardButton получил официальные поля:
 *  • icon_custom_emoji_id — кастом-эмодзи ПЕРЕД текстом кнопки. Доступно
 *    ботам с Fragment-юзернеймом ИЛИ (наш случай) в сообщениях, отправленных
 *    ботом НАПРЯМУЮ в private/group/supergroup, если у ВЛАДЕЛЬЦА бота есть
 *    Telegram Premium (владелец 7851246214 — premium, проверено v5.23).
 *    ID берутся из слотов premiumMap() (tg-emoji.ts), прод: 15/16 заполнено.
 *  • style — 'danger' (красная), 'success' (зелёная), 'primary' (синяя).
 *
 * Правила надёжности:
 *  • иконки ставим ТОЛЬКО на прямые отправки бота — сообщения от имени
 *    business-аккаунта иконки не поддерживают (туда уходит plain-клавиатура);
 *  • если Telegram отверг клавиатуру с иконками (Premium истёк / битый ID) —
 *    отправитель повторяет цепочку с plain-клавиатурой: текст кнопки
 *    'emoji + label' (разноцветный юникод виден у всех) — сообщение не теряется;
 *  • style не премиум-зависим, остаётся в обоих вариантах.
 */

export type BotButton = {
  /** Текст кнопки БЕЗ эмодзи — так рисуется при живой иконке */
  label: string
  /** Юникод-эмодзи: ключ слота для иконки + префикс в plain-фолбэке */
  emoji?: string
  url?: string
  callback_data?: string
  style?: 'danger' | 'success' | 'primary'
}

export type InlineKeyboardButtonTg = {
  text: string
  icon_custom_emoji_id?: string
  style?: string
  url?: string
  callback_data?: string
}

export type InlineKeyboardMarkupTg = { inline_keyboard: InlineKeyboardButtonTg[][] }

/** '✅ ' + 'Войти' → '✅ Войти' (пустые части отбрасываются) */
function labelOf(b: BotButton): string {
  return [b.emoji, b.label].filter(Boolean).join(' ')
}

function actionOf(b: BotButton): Pick<InlineKeyboardButtonTg, 'url' | 'callback_data'> {
  return b.url ? { url: b.url } : b.callback_data ? { callback_data: b.callback_data } : {}
}

/**
 * Клавиатура с премиум-иконками: где слот знает custom_emoji_id для эмодзи
 * кнопки — текст без юникод-эмодзи (иконка заменяет его), иначе юникод.
 * hasIcons=true → отправитель знает, что есть смысл в фолбэке без иконок.
 */
export function buildIconKeyboard(
  rows: BotButton[][],
  slotMap: Map<string, string>,
): { markup: InlineKeyboardMarkupTg; hasIcons: boolean } {
  let hasIcons = false
  const inline_keyboard = rows.map((row) =>
    row.map((b): InlineKeyboardButtonTg => {
      const id = b.emoji ? slotMap.get(b.emoji) : undefined
      if (id) hasIcons = true
      return {
        text: id ? b.label : labelOf(b),
        ...(id ? { icon_custom_emoji_id: id } : {}),
        ...(b.style ? { style: b.style } : {}),
        ...actionOf(b),
      }
    }),
  )
  return { markup: { inline_keyboard }, hasIcons }
}

/** Фолбэк-клавиатура: без иконок, 'emoji + label' юникодом, стили остаются */
export function buildPlainKeyboard(rows: BotButton[][]): InlineKeyboardMarkupTg {
  return {
    inline_keyboard: rows.map((row) =>
      row.map(
        (b): InlineKeyboardButtonTg => ({
          text: labelOf(b),
          ...(b.style ? { style: b.style } : {}),
          ...actionOf(b),
        }),
      ),
    ),
  }
}
