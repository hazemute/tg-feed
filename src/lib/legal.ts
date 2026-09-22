/**
 * Реквизиты исполнителя для документов приложения («Реквизиты и контакты»,
 * оферта — требования платёжного провайдера Platega, v5.83).
 *
 * Platega не требует публикации персональных данных (ИП/ИНН) в интерфейсе —
 * v5.43: вместо них полные документы по постоянным ссылкам (/terms, /privacy,
 * /pricing, /contacts). Env LEGAL_NAME/LEGAL_INN по-прежнему перекрывает
 * дефолт, если владелец сам решит показать реквизиты.
 */
const DEFAULT_LEGAL = {
  name: 'Проект Tg Swipe',
  inn: '',
} as const

export function legalInfo(): { name: string; inn: string; email: string } {
  return {
    name: process.env.LEGAL_NAME?.trim() || DEFAULT_LEGAL.name,
    inn: process.env.LEGAL_INN?.trim() || DEFAULT_LEGAL.inn,
    email: process.env.SUPPORT_EMAIL?.trim() ?? '',
  }
}
