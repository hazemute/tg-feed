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
  'nav.quests': ['Задания', 'Quests'],
  'nav.search': ['Поиск', 'Search'],
  'nav.channel': ['Каналы', 'Channels'],
  'nav.mychannel': ['Мой канал', 'My channel'],
  'nav.profile': ['Профиль', 'Profile'],
  'nav.main': ['Основная навигация', 'Main navigation'],
  'nav.tagline': ['лента Telegram-каналов', 'Telegram channels feed'],
  'nav.reader': ['Читатель', 'Reader'],
  /* «Мой канал» уехал из навбара в профиль вниз (разгрузка интерфейса) */
  'profile.myChannelRow': ['Мой канал', 'My channel'],
  'profile.myChannelHint': ['статистика, показ в ленте и продвижение', 'stats, feed display and promotion'],
  'profile.infoRow': ['Информация', 'Information'],
  'profile.infoHint': ['о приложении и документы', 'about the app and documents'],
  'profile.fbRow': ['Обратная связь', 'Feedback'],
  'profile.fbHint': ['поддержка и предложения', 'support and suggestions'],
  'profile.infoSheet': ['Информация', 'Information'],
  'profile.infoSheetSub': ['О приложении, соглашения и версия', 'About, agreements and version'],
  'profile.fbSheet': ['Обратная связь', 'Feedback'],
  'profile.fbSheetSub': ['Помогите сделать приложение лучше', 'Help make the app better'],
  /* Snap Ассистент (v5.40): из карточки «Мой канал» — в строки профиля */
  'profile.assistantRow': ['Snap Ассистент', 'Snap Assistant'],
  'profile.assistantHint': ['ИИ-контентщик канала', 'channel AI co-writer'],
  /* Вкладки кабинета «Мой канал» (вместо бесконечной простыни) */
  'mc.tabStats': ['Аналитика', 'Analytics'],
  'mc.tabDisplay': ['Показ', 'Feed display'],
  'mc.tabAds': ['Продвижение', 'Promotion'],
  'mc.tabsAria': ['Разделы кабинета канала', 'Channel cabinet sections'],
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
  'post.more': ['ещё', 'more'],
  'post.story': ['В историю', 'Story'],
  'post.storyAria': [
    'Поделиться постом в Telegram Stories',
    'Share post to Telegram Stories',
  ],
  /* Шит «Поделиться»: Telegram / Stories / копирование — вместо бардака кнопок */
  'post.shareSheet': ['Поделиться', 'Share'],
  'post.shareSheetSub': ['Поделиться постом', 'Share this post'],
  'post.shareTg': ['В Telegram', 'To Telegram'],
  'post.shareTgHint': ['отправить в чат или канал', 'send to a chat or channel'],
  'post.shareStory': ['В историю', 'To story'],
  'post.shareStoryHint': ['картинка поста + ссылка на канал', 'post picture + channel link'],
  'post.shareCopy': ['Скопировать ссылку', 'Copy link'],
  'post.shareCopyHint': ['ссылка на пост в буфер обмена', 'copy the post link to clipboard'],
  'post.linkCopied': ['Ссылка скопирована', 'Link copied'],
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
  'tts.tooShort': ['В посте слишком мало текста для озвучки', 'Not enough text in the post for a voice-over'],
  'tts.unavailable': ['Озвучка недоступна', 'Voice-over unavailable'],
  'post.featuredAria': ['Продвинутый канал', 'Featured channel'],

  /* Время */
  'time.now': ['только что', 'just now'],
  'time.min': ['мин', 'min'],
  'time.hour': ['ч', 'h'],
  'time.day': ['дн', 'd'],

  /* Профиль: базовое */
  'profile.name': ['Пользователь', 'User'],
  'profile.noUsername': ['Без username', 'No username'],
  /* Уровни (v5.75): XP-бар под ником + шит уровня */
  'level.short': ['Ур.', 'Lvl'],
  'level.title': ['Уровень', 'Level'],
  'level.subtitle': ['Опыт и награды', 'XP and rewards'],
  'level.toNext': ['до следующего уровня', 'to next level'],
  'level.rewardForLevel': ['награда за уровень', 'level-up reward'],
  'level.howTo': ['Как получать XP', 'How to earn XP'],
  'level.history': ['Последние начисления', 'Recent XP'],
  'level.today': ['Сегодня засчитано', 'Counted today'],
  'level.commentRow': ['Толковый комментарий (от 10 символов)', 'A good comment (10+ chars)'],
  'level.likeRow': ['Лайк на вашем комментарии', 'Like on your comment'],
  'level.questRow': ['Выполненное задание', 'Quest completed'],
  'level.checkinRow': ['Ежедневный чек-ин', 'Daily check-in'],
  'level.bugRow': ['Найденный баг', 'Found a bug'],
  'level.bugHint': ['начисляет админ', 'granted by admin'],
  'level.violationRow': ['Нарушение правил', 'Rule violation'],
  'level.violationHint': ['скрытый/удалённый комментарий или бан', 'hidden/deleted comment or ban'],
  'level.capNote': ['в день', 'per day'],
  'level.empty': ['Пока пусто', 'Empty for now'],
  'level.guestTitle': ['Войдите по Telegram', 'Sign in with Telegram'],
  'level.guestHint': ['XP за активность · свайпы за уровни', 'XP for activity · swipes for levels'],
  'level.progressAria': ['Прогресс уровня', 'Level progress'],
  /* Лидерборды (v5.87): не рублёвые — уровни, свайпы, активность */
  'lb.title': ['Лидерборды', 'Leaderboards'],
  'lb.subtitle': ['Топы игроков', 'Player tops'],
  'lb.windowAll': ['за всё время', 'all time'],
  'lb.window30d': ['за 30 дней', 'last 30 days'],
  'lb.tabLevel': ['Уровни', 'Levels'],
  'lb.tabSwipes': ['Свайпы', 'Swipes'],
  'lb.tabViews': ['Просмотры', 'Views'],
  'lb.tabLikes': ['Лайки', 'Likes'],
  'lb.tabComments': ['Комментарии', 'Comments'],
  'lb.tabAria': ['Разделы лидерборда', 'Leaderboard sections'],
  'lb.me': ['Вы', 'You'],
  'lb.outOfTop': ['вне топа', 'out of top'],
  'lb.noActivity': ['нет активности', 'no activity yet'],
  'lb.levelValue': ['уровень', 'level'],
  'lb.swipesValue': ['свайпов', 'swipes'],
  'lb.viewsValue': ['просмотров', 'views'],
  'lb.likesValue': ['лайков', 'likes'],
  'lb.commentsValue': ['комментариев', 'comments'],
  'lb.guestTitle': ['Войдите, чтобы попасть в таблицу', 'Sign in to get on the board'],
  'lb.guestHint': ['Займёт пару секунд', 'Takes a couple of seconds'],
  'lb.refresh': ['Обновить', 'Refresh'],
  'lb.empty': ['Пока пусто', 'Empty for now'],
  'lb.failed': ['Не удалось загрузить', 'Failed to load'],
  'lb.retry': ['Повторить', 'Retry'],
  'lb.openFromLevel': ['Лидерборд уровней', 'Level leaderboard'],
  'lb.openFromLevelHint': ['топ по XP', 'top by XP'],
  // v5.88: награды за активность (топ-3 по XP недели/месяца получают свайпы)
  'lb.prizeTitle': ['Награды за активность', 'Activity prizes'],
  'lb.prizeWeek': ['Топ-3 недели', 'Weekly top 3'],
  'lb.prizeMonth': ['Топ-3 месяца', 'Monthly top 3'],
  'lb.prizeEach': ['по', 'each'],
  'lb.prizeLiveWeek': ['Текущая неделя', 'This week'],
  'lb.prizeLastWeek': ['Прошлая неделя', 'Last week'],
  'lb.prizeLastMonth': ['Прошлый месяц', 'Last month'],
  'profile.lbRow': ['Лидерборды', 'Leaderboards'],
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
  'settings.subtitle': ['Оформление · тариф · информация', 'Appearance · plan · about'],
  'settings.theme': ['Тема', 'Theme'],
  'settings.allThemes': ['Все темы', 'All themes'],
  'settings.tier': ['Тариф Snap', 'Snap plan'],
  'settings.legal': ['Соглашение · конфиденциальность', 'Terms · privacy'],
  'settings.font': ['Размер шрифта постов', 'Post font size'],
  'settings.fontSm': ['Мелкий шрифт', 'Small font'],
  'settings.fontMd': ['Средний шрифт', 'Medium font'],
  'settings.fontLg': ['Крупный шрифт', 'Large font'],
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
  'toolbar.lang': ['Язык', 'Language'],
  'toolbar.langAria': [
    'Фильтр по языку: тап — все языки → русский → другие',
    'Language filter: tap — all → Russian → other languages',
  ],
  'toolbar.langRu': ['Русский', 'Russian'],
  'toolbar.langOther': ['Другие', 'Other'],
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
  'feed.postHiddenToast': ['Пост скрыт', 'Post hidden'],
  'feed.postHiddenHint': ['Похожие посты — реже', 'Similar posts — less often'],
  'feed.reportTitle': ['Пожаловаться на пост', 'Report post'],
  'feed.reportSent': ['Жалоба отправлена', 'Report sent'],
  'feed.reportAlready': ['Вы уже отправляли жалобу на этот пост', 'You already reported this post'],
  'feed.reportReasonSpam': ['Реклама или спам', 'Ads or spam'],
  'feed.reportReasonAbuse': ['Оскорбления или травля', 'Harassment or abuse'],
  'feed.reportReasonMisinfo': ['Вводит в заблуждение', 'Misinformation'],
  'feed.reportReasonOther': ['Другое', 'Something else'],
  'feed.unhideToast': ['Вернуть', 'Undo'],
  'feed.notInterested': ['Не интересно — скрыть канал', 'Not interested — hide channel'],
  'feed.minRead': ['мин', 'min read'],
  'feed.reasonHint': [
    'Пост показан, потому что он может вам понравиться',
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
  'support.typing': ['Поддержка печатает…', 'Support is typing…'],
  'support.loading': ['Загрузка', 'Loading'],
  'support.staff': ['Сотрудник поддержки', 'Support team'],
  'support.clear': ['Очистить историю', 'Clear history'],
  'support.clearQ': ['Удалить все сообщения этого чата?', 'Delete all messages in this chat?'],
  'support.clearYes': ['Очистить', 'Clear'],
  'support.clearNo': ['Отмена', 'Cancel'],
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
  'comments.emptyHint': ['Скажите, что думаете', 'Say what you think'],
  'comments.placeholder': ['Написать комментарий…', 'Add a comment…'],
  'comments.send': ['Отправить', 'Send'],
  'comments.more': ['Показать ещё', 'Load more'],
  'comments.retry': ['Повторить', 'Retry'],
  'comments.error': ['Не получилось. Попробуйте ещё раз', 'Something went wrong. Try again'],
  'comments.login': ['Войдите, чтобы комментировать', 'Sign in to comment'],
  'comments.tooLong': ['Слишком длинный комментарий', 'Comment is too long'],
  'comments.deleted': ['Комментарий удалён', 'Comment deleted'],
  'comments.delete': ['Удалить комментарий', 'Delete comment'],
  // v5.77: плашка действий долгого нажатия (TikTok-стиль)
  'comments.copy': ['Копировать', 'Copy'],
  'comments.copied': ['Скопировано', 'Copied'],
  /* Дерево/лайки комментариев (v5.13, TikTok-стиль) */
  'comments.sortNew': ['Новые', 'New'],
  'comments.sortTop': ['Популярные', 'Top'],
  'comments.reply': ['Ответить', 'Reply'],
  'comments.replyTag': ['Ответ', 'Replying to'],
  'comments.replyPlaceholder': ['Ваш ответ…', 'Your reply…'],
  'comments.showReplies': ['Показать ответы', 'Show replies'],
  'comments.hideReplies': ['Скрыть ответы', 'Hide replies'],
  'comments.moreReplies': ['Показать ещё ответы', 'Show more replies'],
  'comments.like': ['Нравится', 'Like'],
  'comments.cancelReply': ['Отменить ответ', 'Cancel reply'],
  'comments.repliesOne': ['ответ', 'reply'],
  'comments.repliesFew': ['ответа', 'replies'],
  'comments.repliesMany': ['ответов', 'replies'],

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
    'Пост короткий — саммари не нужно, просто прочитайте его целиком',
    'This post is short — no summary needed, just read it in full',
  ],
  'summary.error': ['Не удалось сгенерировать саммари', 'Failed to generate the summary'],
  'summary.disclaimer': [
    'Сгенерировано нейросетью · может ошибаться в деталях',
    'AI-generated · may be inaccurate in details',
  ],
  'summary.fallbackNote': [
    'Предварительная выжимка по началу текста · может быть неполной',
    'Preliminary digest based on the beginning of the text · may be incomplete',
  ],

  /* Конец ленты / ошибки загрузки */
  'feed.endTitle': ['Конец ленты', "You're all caught up"],
  'feed.endHint': ['Новое уже скоро', 'Fresh posts soon'],
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
  'topup.cardSub': ['Оплата картой/СБП · Platega', 'Card/SBP checkout · Platega'],
  'topup.starsSub': ['Оплата в самом Telegram', 'Pay right in Telegram'],
  'topup.tonSub': ['Tonkeeper и любые TON-кошельки', 'Tonkeeper and any TON wallet'],
  'topup.soon': ['Скоро', 'Soon'],
  'topup.unavailable': ['Появится в ближайшее время', 'Coming soon'],
  'topup.emptyTitle': ['Пополнение скоро появится', 'Top-up is coming soon'],
  'topup.emptyBody': [
    'Способы оплаты ещё настраиваются. А свайпы уже можно заработать: задания, уровни, розыгрыши.',
    'Payment methods are being set up. Meanwhile you can already earn swipes: quests, levels, giveaways.',
  ],
  'topup.emptyOk': ['Понятно', 'Got it'],
  'topup.custom': ['Своя сумма — от 100 ₽', 'Custom amount — from ₽100'],
  'topup.customAria': ['Сумма пополнения в рублях', 'Top-up amount in rubles'],
  'topup.range': ['от 100 до 50 000 ₽', 'from ₽100 to ₽50,000'],
  'topup.toPay': ['к оплате', 'to pay'],
  'topup.rate1': ['на рублёвый баланс', 'to your RUB balance'],
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
    'Деньги зачисляются на рублёвый баланс и тратятся на всё в сервисе: свайпы для нейросетей, тарифы Snap, продвижение каналов',
    'Money goes to your RUB balance and pays for everything: AI swipes, Snap plans, channel promotion',
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
  'topup.memoLabel': ['Код платежа (укажите в комментарии)', 'Payment code (required in the comment)'],
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

  /* Пополнение · СБП/карта (Platega) и возврат со страницы оплаты */
  'topup.tabSbp': ['СБП', 'SBP'],
  'topup.cardViaPlatega': [
    'Оплата картой МИР через безопасную страницу банка — без ввода данных в приложении',
    'Pay with a MIR card on the secure bank page — no card data entered in the app',
  ],
  'topup.sbpHint': [
    'Оплата по QR через СБП: приложение вашего банка откроется автоматически после создания счёта',
    'Pay via SBP QR: your bank app opens automatically once the invoice is created',
  ],
  'topup.plategaWaiting': ['Ждём оплату', 'Waiting for payment'],
  'topup.plategaHint': [
    'Счёт открыт. Оплатите его на странице банка — баланс пополнится автоматически сразу после подтверждения.',
    'Invoice created. Pay it on the bank page — your balance will be topped up automatically right after confirmation.',
  ],
  'topup.plategaOpen': ['Открыть страницу оплаты', 'Open payment page'],
  'topup.plategaCheck': ['Проверить оплату', 'Check payment'],
  'topup.plategaFailedHint': [
    'Счёт не оплачен или отменён. Деньги за неисполненный счёт не списываются — попробуйте ещё раз.',
    'The invoice was not paid or was cancelled. Nothing was charged — please try again.',
  ],
  'topup.plategaRetry': ['Попробовать снова', 'Try again'],
  'topup.returnedDone': ['Баланс пополнен', 'Balance topped up'],
  'topup.returnedFail': ['Платёж не завершён. Деньги вернутся автоматически', 'Payment incomplete. Your money will be refunded automatically'],
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
