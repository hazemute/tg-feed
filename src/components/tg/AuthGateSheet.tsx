'use client'

import { Heart, Lock, Send, Sparkles, Zap } from 'lucide-react'
import { useApp } from '@/lib/store'
import { haptic } from '@/lib/tg'
import { BottomSheet } from '@/components/tg/BottomSheet'

/**
 * Ленивая регистрация (Lazy Auth): гость свободно свайпает и читает,
 * но лайк/закладка открывают эту шторку — «привяжи Telegram за 2 секунды».
 *
 * Тексты — продуктовые: что получит человек (сохранение постов, синхронизация
 * между телефоном и сайтом), а не «зарегистрируйтесь, потому что надо».
 * История чтения гостя переезжает в аккаунт автоматически — честно сообщаем.
 */

const COPY: Record<string, { title: string; text: string }> = {
  like: {
    title: 'Сохраните этот лайк',
    text: 'Привяжите Telegram — и все лайки будут с вами и на телефоне, и на компьютере. История чтения уже сохранена и переедет вместе с аккаунтом.',
  },
  bookmark: {
    title: 'Сохраните пост навсегда',
    text: 'Понадобится всего 2 секунды: подтвердите аккаунт в нашем боте — и пост останется в закладках на всех устройствах.',
  },
  comment: {
    title: 'Присоединяйтесь к обсуждению',
    text: 'Комментарии — для настоящих людей, поэтому нужен привязанный Telegram: 2 секунды в боте — и вы можете обсуждать посты.',
  },
  ai_search: {
    title: 'Продолжите задавать вопросы ИИ',
    text: 'Бесплатные запросы Snap Search на сегодня закончились. Привяжите Telegram, чтобы сохранить прогресс, — а безлимитный Snap Search включается в тарифе Snap Plus.',
  },
  default: {
    title: 'Пара секунд — и всё сохранится',
    text: 'Привяжите Telegram, чтобы сохранять посты и ставить лайки. Ничего не потеряется: история уже с вами.',
  },
}

export function AuthGateSheet() {
  const authGate = useApp((s) => s.authGate)
  const closeAuthGate = useApp((s) => s.closeAuthGate)
  const setLoginOpen = useApp((s) => s.setLoginOpen)

  const open = !!authGate
  const copy = COPY[authGate ?? ''] ?? COPY.default

  const goLogin = () => {
    haptic('light')
    closeAuthGate()
    setLoginOpen(true)
  }

  return (
    <BottomSheet open={open} onClose={closeAuthGate} title="Вход за 2 секунды" zClass="z-[90]">
      <div className="pb-1">
        {/* Иллюстрация */}
        <div className="flex items-center gap-2" aria-hidden>
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-tg-like/12">
            <Heart className="h-5.5 w-5.5 text-tg-like" />
          </span>
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-tg-link/10">
            <Sparkles className="h-5.5 w-5.5 text-tg-link" />
          </span>
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-tg-star/12">
            <Zap className="h-5.5 w-5.5 text-tg-star" />
          </span>
        </div>

        <h3 className="mt-3.5 text-[17.5px] font-bold leading-snug text-tg-text">{copy.title}</h3>
        <p className="mt-1.5 text-[14px] leading-relaxed text-tg-hint">{copy.text}</p>

        <ul className="mt-3.5 space-y-2">
          {[
            'Лайки, закладки и подписки — на всех устройствах',
            'История чтения переедет автоматически',
            'Без паролей: подтверждение в Telegram-боте',
          ].map((line) => (
            <li key={line} className="flex items-start gap-2 text-[13.5px] text-tg-text2">
              <span className="mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full bg-emerald-500/12">
                <Lock className="h-2.5 w-2.5 text-emerald-600 dark:text-emerald-400" strokeWidth={3} />
              </span>
              {line}
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={goLogin}
          className="mt-4 flex h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-tg-link text-[15.5px] font-bold text-white transition active:scale-[0.98]"
        >
          <Send className="h-5 w-5" />
          Привязать Telegram
        </button>
        <button
          type="button"
          onClick={closeAuthGate}
          className="mt-2 h-11 w-full rounded-2xl text-[14px] font-semibold text-tg-hint transition active:opacity-60"
        >
          Потом
        </button>
      </div>
    </BottomSheet>
  )
}
