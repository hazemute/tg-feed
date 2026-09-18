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
  'post.more': ['...еще', 'more'],
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
  'feed.unhideToast': ['Вернуть', 'Undo'],
  'feed.notInterested': ['Не интересно — скрыть пост', 'Not interested — hide post'],
  'feed.minRead': ['мин', 'min read'],
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
