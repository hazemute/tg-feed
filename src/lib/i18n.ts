'use client'

import { useCallback } from 'react'
import { useApp } from '@/lib/store'

/**
 * Лёгкая локализация интерфейса (ru/en) без внешних зависимостей:
 * словарь «ключ → [ru, en]» + хук useT(). Строки, не попавшие в словарь,
 * фолбэкаются на русский — покрытие расширяется постепенно.
 */

export type Lang = 'ru' | 'en'

export const LANG_LIST: { id: Lang; label: string; native: string }[] = [
  { id: 'ru', label: 'Русский', native: 'Русский' },
  { id: 'en', label: 'English', native: 'English' },
]

const DICT = {
  /* Навигация */
  'nav.feed': ['Лента', 'Feed'],
  'nav.trending': ['Тренды', 'Trending'],
  'nav.search': ['Поиск', 'Search'],
  'nav.channel': ['Канал', 'Channel'],
  'nav.mychannel': ['Мой канал', 'My channel'],
  'nav.profile': ['Профиль', 'Profile'],
  'nav.main': ['Основная навигация', 'Main navigation'],
  'nav.tagline': ['лента Telegram-каналов', 'Telegram channels feed'],
  'nav.reader': ['Читатель', 'Reader'],
  'profile.reader': ['Читатель', 'Reader'],
  'profile.subGuestHint': ['Войдите, чтобы сохранять посты', 'Sign in to save posts'],
  'authGate.title': ['Вход за 2 секунды', 'Sign in within seconds'],
  'authGate.later': ['Потом', 'Later'],

  /* Полный экран поста */
  'post.title': ['Пост', 'Post'],
  'post.back': ['Назад', 'Back'],
  'post.prev': ['Предыдущий пост', 'Previous post'],
  'post.next': ['Следующий пост', 'Next post'],
  'post.pager': ['Навигация между постами', 'Post navigation'],
  'post.subscribers': ['подписчиков', 'subscribers'],
  'post.views': ['просмотров', 'views'],
  'post.likes': ['лайков', 'likes'],
  'post.inBookmarks': ['в закладках', 'saved'],
  'post.like': ['Нравится', 'Like'],
  'post.save': ['Сохранить', 'Save'],
  'post.share': ['Поделиться', 'Share'],
  'post.shareAria': ['Поделиться постом', 'Share post'],
  'post.savedToast': ['Сохранено', 'Saved'],
  'post.unsavedToast': ['Убрано из сохранённых', 'Removed from saved'],
  'post.likeError': ['Не удалось сохранить лайк', "Couldn't save your like"],
  'post.error': ['Ошибка', 'Error'],
  'post.premium': ['Продвинутый канал', 'Featured channel'],
  'post.openChannel': ['Открыть канал', 'Open channel'],
  'post.readInTg': ['Читать полностью в Telegram', 'Read full post in Telegram'],
  'post.teaserHint': [
    'Автор показывает полный текст только подписчикам канала',
    'The author shows the full text to channel subscribers only',
  ],
  'post.summary': ['Краткое содержание', 'Summary'],
  'post.more': ['еще', 'more'],
  'post.story': ['В историю', 'Story'],
  'post.storyAria': [
    'Поделиться постом в Telegram Stories',
    'Share post to Telegram Stories',
  ],
  'ch.tabPosts': ['Посты', 'Posts'],
  'ch.tabMedia': ['Медиа', 'Media'],
  'ch.tabLinks': ['Ссылки', 'Links'],
  'ch.tabsAria': ['Разделы канала', 'Channel sections'],
  'ch.tabEmpty': ['Здесь пока ничего нет', 'Nothing here yet'],
  'post.readMore': ['Читать пост полностью', 'Read full post'],
  'card.inChannel': ['в канале', 'in channel'],
  'card.views': ['просмотров', 'views'],
  'card.actions': ['Действия', 'Actions'],
  'tts.listen': ['Слушать', 'Listen'],
  'tts.generating': ['Генерируем…', 'Generating…'],
  'tts.playing': ['Играет', 'Playing'],
  'tts.pause': ['Пауза', 'Pause'],
  'tts.aria': ['Слушать пост', 'Listen to post'],
  'tts.error': ['Озвучка недоступна, попробуйте позже', 'Voice-over unavailable, try again later'],
  'tts.tooShort': ['В посте слишком мало текста для озвучки', 'Too little text in the post to voice'],
  'tts.unavailable': ['Озвучка недоступна', 'Voice-over unavailable'],
  'post.featuredAria': ['Продвинутый канал', 'Featured channel'],

  /* Время */
  'time.now': ['только что', 'just now'],
  'time.min': ['мин', 'min'],
  'time.hour': ['ч', 'h'],
  'time.day': ['дн', 'd'],

  /* Профиль: базовое */
  'profile.name': ['Пользователь', 'User'],
  'profile.guestDemo': ['Гость · демо-режим', 'Guest · demo mode'],
  'profile.noUsername': ['Без username', 'No username'],
  'profile.untieBookmark': ['Не удалось убрать закладку', "Couldn't remove the bookmark"],
  'profile.markedRead': ['Всё сохранённое прочитано', 'All saved posts marked as read'],
  'profile.markReadFail': ['Не удалось отметить прочитанным', "Couldn't mark as read"],
  'profile.channelsInTab': ['Ваши каналы — во вкладке «Каналы»', 'Your channels live in the "Channel" tab'],
  'profile.hiddenFeed': ['скрыт из ленты', 'hidden from feed'],
  'profile.mediaPost': ['медиа-пост', 'media post'],
  'profile.notifOn': ['Уведомления включены', 'Notifications on'],
  'profile.notifOff': ['Уведомления выключены', 'Notifications off'],
  'profile.stActive': ['активен', 'active'],
  'profile.stModeration': ['на модерации', 'under review'],
  'profile.stRejected': ['отклонён модератором', 'rejected by moderator'],
  'profile.sentModeration': ['Канал отправлен на модерацию', 'Channel submitted for review'],
  'profile.addFail': ['Не удалось добавить канал', "Couldn't add the channel"],
  'profile.settings': ['Настройки', 'Settings'],
  /* Настройки */
  'settings.font': ['Размер шрифта постов', 'Post font size'],
  'profile.language': ['Язык интерфейса', 'Interface language'],

  /* Переключатель языка */
  'lang.title': ['Язык', 'Language'],
  'lang.hint': ['Переключение языка интерфейса', 'Switch the interface language'],

  /* Тулбар ленты: поиск и фильтры */
  'toolbar.search': ['Поиск в ленте', 'Search feed'],
  'toolbar.searchAria': ['Поиск по загруженным постам ленты', 'Search loaded feed posts'],
  'toolbar.clear': ['Очистить поиск', 'Clear search'],
  'toolbar.media': ['Медиа', 'Media'],
  'toolbar.mediaAria': ['Только посты с медиа', 'Posts with media only'],
  'toolbar.day': ['24ч', '24h'],
  'toolbar.dayAria': ['Только посты за сутки', 'Posts from the last 24 hours only'],
  'toolbar.top': ['Топ', 'Top'],
  'toolbar.topAria': ['Сначала популярные', 'Popular first'],
  'toolbar.shownPrefix': ['Показано', 'Showing'],
  'toolbar.of': ['из', 'of'],
  'toolbar.reset': ['сбросить', 'reset'],
  'toolbar.unhide': ['вернуть скрытые', 'restore hidden'],
  'toolbar.empty': ['Ничего не найдено', 'Nothing found'],
  'toolbar.emptyHint': [
    'Попробуйте изменить запрос или снять фильтры',
    'Try changing the query or clearing the filters',
  ],
  'toolbar.resetFilters': ['Сбросить фильтры', 'Reset filters'],

  /* Скрытие поста («Не интересно») */
  'feed.hiddenToast': ['Пост скрыт из ленты', 'Post hidden from feed'],
  'feed.channelHiddenToast': ['Канал скрыт из ленты', 'Channel hidden from your feed'],
  'feed.unhideToast': ['Вернуть', 'Undo'],
  'feed.notInterested': ['Не интересно — скрыть канал', 'Not interested — hide channel'],
  'feed.minRead': ['мин', 'min read'],
  'feed.reasonHint': [
    'Пост показан, потому что он вам может понравиться',
    'Recommended because it may interest you',
  ],

  /* Чат поддержки */
  'support.title': ['Поддержка', 'Support'],
  'support.subtitle.ai': ['отвечает нейросеть', 'AI assistant replying'],
  'support.subtitle.human': ['на связи сотрудник', 'staff member online'],
  'support.subtitle.closed': ['обращение закрыто', 'request closed'],
  'support.subtitle.idle': ['онлайн, отвечаем быстро', 'online, quick replies'],
  'support.back': ['Назад', 'Back'],
  'support.dialog': ['Чат поддержки', 'Support chat'],
  'support.input': ['Сообщение…', 'Message…'],
  'support.send': ['Отправить', 'Send'],
  'support.welcomeTitle': ['Чем помочь?', 'How can we help?'],
  'support.welcomeText': [
    'Задайте вопрос о работе ленты, подписках или каналах. Сложные обращения мы передаём живому сотруднику.',
    'Ask anything about the feed, subscriptions or channels. Complex requests are escalated to a human teammate.',
  ],
  'support.typing': ['Поддержка печатает', 'Support is typing'],
  'support.loading': ['Загрузка', 'Loading'],
  'support.staff': ['Сотрудник поддержки', 'Support team'],
  'support.escalated': ['Обращение передано сотруднику поддержки', 'Your request was passed to a human teammate'],
  'support.profileRow': ['Чат поддержки', 'Support chat'],
  'support.profileHint': ['отвечаем быстро', 'we reply fast'],
  'support.section': ['Поддержка', 'Support'],
  /* Предложка / баг (v5.11): чат напрямую админу, без нейронки */
  'feedback.title': ['Предложка / Баг', 'Ideas / Bugs'],
  'feedback.dialog': ['Предложка и баг-репорты', 'Ideas and bug reports'],
  'feedback.subtitle': ['пишет админу напрямую', 'straight to the admin'],
  'feedback.subtitleIdle': ['новая тема', 'new thread'],
  'feedback.topicIdea': ['Идея', 'Idea'],
  'feedback.topicBug': ['Баг', 'Bug'],
  'feedback.welcomeTitle': ['Помогите сделать Tg Swipe лучше', 'Help make Tg Swipe better'],
  'feedback.welcomeText': [
    'Выберите «Идея» или «Баг» и опишите: что предложить или что сломалось. Можно приложить скриншот — попадёт прямо к админу.',
    'Pick “Idea” or “Bug” and describe it. Attach a screenshot if needed — it goes straight to the admin.',
  ],
  'feedback.input': ['Что предложить или что не работает?', 'Suggest an idea or report a bug…'],
  'feedback.attach': ['Прикрепить картинку', 'Attach an image'],
  'feedback.removeImage': ['Убрать картинку', 'Remove image'],
  'feedback.uploading': ['Загружаем…', 'Uploading…'],
  'feedback.imageAlt': ['Прикреплённая картинка', 'Attached image'],

  // Комментарии под постом
  'comments.title': ['Комментарии', 'Comments'],
  /* Экран «Уведомления»: вкладки Посты / Активность */
  'notif.title': ['Уведомления', 'Notifications'],
  'notif.posts': ['Посты', 'Posts'],
  'notif.activity': ['Активность', 'Activity'],
  'notif.emptyPosts': ['Новых постов нет', 'No new posts'],
  'notif.emptyPostsHint': [
    'Включите колокольчик у каналов, чтобы не пропустить новое',
    'Turn on the bell on channels to catch new posts',
  ],
  'notif.emptyActivity': ['Событий пока нет', 'Nothing here yet'],
  'notif.emptyActivityHint': [
    'Комментарии, ответы поддержки и статусы кампаний появятся здесь',
    'Comments, support replies and campaign updates will appear here',
  ],
  'notif.failed': ['Не удалось загрузить', "Couldn't load"],
  'notif.failedHint': ['Проверьте соединение и попробуйте ещё раз', 'Check your connection and try again'],
  'notif.retry': ['Повторить', 'Retry'],
  'notif.media': ['Медиа', 'Media'],
  'notif.newPost': ['Новый пост', 'New post'],
  'notif.unread': ['Непрочитано', 'Unread'],
  'comments.count': ['комментариев', 'comments'],
  'comments.emptyTitle': ['Пока ни одного комментария', 'No comments yet'],
  'comments.emptyHint': ['Будьте первым — скажите, что думаете', 'Be the first to share what you think'],
  'comments.placeholder': ['Написать комментарий…', 'Add a comment…'],
  'comments.send': ['Отправить', 'Send'],
  'comments.more': ['Показать ещё', 'Load more'],
  'comments.retry': ['Повторить', 'Retry'],
  'comments.error': ['Не получилось. Попробуйте ещё раз', 'Something went wrong. Try again'],
  'comments.login': ['Войдите, чтобы комментировать', 'Sign in to comment'],
  'comments.tooLong': ['Слишком длинный комментарий', 'Comment is too long'],
  'comments.deleted': ['Комментарий удалён', 'Comment deleted'],
  'comments.delete': ['Удалить комментарий', 'Delete comment'],

  /* Перевод поста (Twitter-style) */
  'translate.do': ['Перевести', 'Translate'],
  'translate.doing': ['Переводим…', 'Translating…'],
  'translate.showOriginal': ['Показать оригинал', 'Show original'],
  'translate.showTranslation': ['Показать перевод', 'Show translation'],
  'translate.auto': ['Переведено автоматически', 'Translated automatically'],
  'translate.error': ['Перевод недоступен, попробуйте позже', 'Translation unavailable, try again later'],

  /* Краткое содержание (AI-саммари) */
  'summary.title': ['Краткое содержание', 'Summary'],
  'summary.subtitle': ['выжимка в 3 пунктах', '3-point digest'],
  'summary.close': ['Закрыть', 'Close'],
  'summary.generating': ['Генерируем…', 'Generating…'],
  'summary.tooShort': [
    'Пост короткий — саммари не требуется, просто прочитайте его целиком',
    'This post is short — no summary needed, just read it in full',
  ],
  'summary.error': ['Не удалось сгенерировать саммари', 'Failed to generate the summary'],
  'summary.disclaimer': [
    'Сгенерировано нейросетью · может ошибаться в деталях',
    'AI-generated · may be inaccurate in details',
  ],
  'summary.fallbackNote': [
    'Временный режим: выжимка из первых предложений · нейросеть вернётся позже',
    'Temporary mode: digest of the first sentences · the AI will be back soon',
  ],

  /* Конец ленты / ошибки загрузки */
  'feed.endTitle': ['Вы досмотрели ленту', "You've reached the end"],
  'feed.endHint': ['Загляните чуть позже — каналы публикуют новое', 'Check back later — channels keep posting'],
  'feed.refresh': ['Обновить', 'Refresh'],
  'feed.retryLoad': ['Не загрузилось — повторить', "Couldn't load — retry"],

  /* Пост: разворот текста и копирование */
  'post.collapse': ['Свернуть', 'Collapse'],
  'post.copyText': ['Копировать текст', 'Copy text'],
  'post.copied': ['Скопировано', 'Copied'],
  'post.copyFail': ['Не удалось скопировать', "Couldn't copy"],
  'post.copiedToast': ['Текст скопирован', 'Text copied'],

  /* Пополнение баланса */
  'topup.title': ['Пополнение баланса', 'Top up balance'],
  'topup.titleShort': ['Пополнить баланс', 'Top up'],
  'topup.tabCard': ['Карта', 'Card'],
  'topup.tabStars': ['Stars', 'Stars'],
  'topup.tabTon': ['TON', 'TON'],
  'topup.cardSub': ['Оплата в один экран · ЮKassa', 'One-screen checkout · YooKassa'],
  'topup.starsSub': ['Оплата в самом Telegram', 'Paid right in Telegram'],
  'topup.tonSub': ['Tonkeeper и любые TON-кошельки', 'Tonkeeper and any TON wallet'],
  'topup.soon': ['Скоро', 'Soon'],
  'topup.unavailable': ['Появится в ближайшее время', 'Coming soon'],
  'topup.custom': ['Своя сумма — от 100', 'Custom amount — from 100'],
  'topup.customAria': ['Сумма пополнения в свайпах', 'Top-up amount in swipes'],
  'topup.range': ['от 100 до 50 000 свайпов', 'from 100 to 50,000 swipes'],
  'topup.toPay': ['к оплате', 'to pay'],
  'topup.rate1': ['1 свайп = 1 ₽', '1 swipe = ₽1'],
  'topup.payCard': ['Пополнить на', 'Top up'],
  'topup.payStars': ['Оплатить', 'Pay'],
  'topup.payTon': ['Получить TON-счёт', 'Get TON invoice'],
  'topup.starsOpen': [
    'Счёт открыт в Telegram — подтвердите оплату Stars',
    'Invoice opened in Telegram — confirm the Stars payment',
  ],
  'topup.starsNote': [
    'Stars принимают до 2 500 за один платёж — крупная сумма просто разобьётся на несколько счетов (первый откроется сейчас).',
    'Stars accept up to 2,500 per payment — larger amounts split into several invoices (the first opens now).',
  ],
  'topup.escrow': [
    'Свайпы зачисляются на эскроу-счёт и списываются только за уникальных читателей',
    'Swipes are held in escrow and charged only for unique readers',
  ],
  'topup.invoiceFail': ['Не удалось создать платёж', "Couldn't create the payment"],
  'topup.packName': ['Stars', 'Stars'],
  'topup.swipes': ['свайпов', 'swipes'],
  'topup.waiting': ['Ждём перевод', 'Waiting for transfer'],
  'topup.paid': ['Платёж получен', 'Payment received'],
  'topup.paidHint': [
    'Свайпы уже на балансе — можно запускать продвижение канала',
    'Swipes are on your balance — you can start promoting your channel',
  ],
  'topup.great': ['Отлично', 'Great'],
  'topup.newInvoice': ['Новый счёт', 'New invoice'],
  'topup.otherMethod': ['Выбрать другой способ', 'Choose another method'],
  'topup.addrLabel': ['Адрес кошелька', 'Wallet address'],
  'topup.memoLabel': ['Код платежа (обязательно в комментарии)', 'Payment code (required in the comment)'],
  'topup.tonExpired': [
    'Счёт устарел — курс TON изменился. Нажмите «Новый счёт», чтобы получить актуальный.',
    'Invoice expired — the TON rate changed. Tap "New invoice" to get a fresh one.',
  ],
  'topup.tonHint': [
    'Переводите точно указанную сумму TON с кодом в комментарии — зачисление придёт автоматически в течение минуты после подтверждения сети.',
    'Send the exact TON amount with the code in the comment — it will be credited automatically within a minute after network confirmation.',
  ],
  'topup.openTonkeeper': ['Открыть в Tonkeeper', 'Open in Tonkeeper'],
  'topup.rateSuffix': ['₽/TON', '₽/TON'],
} as const

export type I18nKey = keyof typeof DICT

/** Перевод ключа на язык (фолбэк — русский вариант) */
export function tr(lang: Lang, key: I18nKey): string {
  const entry = DICT[key]
  return lang === 'en' ? entry[1] : entry[0]
}

/** «3 / 24»-пейджер и числа не локализуем; текст — по словарю */
export function useT() {
  const lang = useApp((s) => s.lang)
  return useCallback((key: I18nKey) => tr(lang, key), [lang])
}

/** Полная дата поста в локали интерфейса */
export function fullDateLocalized(lang: Lang, iso: string): string {
  return new Date(iso).toLocaleString(lang === 'en' ? 'en-US' : 'ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
}
