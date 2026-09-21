import Link from 'next/link'
import type { ReactNode } from 'react'

/**
 * Каркас правовых страниц Tg Swipe (v5.43): /privacy, /terms, /pricing, /contacts.
 *
 * Требование платёжного провайдера (Platega, согласование с банком): документы
 * должны быть ПОСТОЯННО доступны по прямым ссылкам — отдельные URL на сайте,
 * плюс кнопки в боте и в миниаппе (Профиль → Информация / Обратная связь).
 *
 * Персональные данные (ИП/ООО/ИНН/ФИО) в документах НЕ публикуются — требование
 * провайдера. Исполнитель обозначается нейтрально как «проект Tg Swipe».
 *
 * КОДОВОЕ СЛОВО ниже — временная метка проверки владения проектом для
 * Platega/банка. УБРАТЬ после согласования эквайринга (одно место — константа).
 */

export const CODE_WORD = 'Квалификация'
export const DOCS_UPDATED = '20 сентября 2026'
export const SITE_ORIGIN = 'https://tg-swipe.vercel.app'

export const LEGAL_NAV = [
  { href: '/privacy', label: 'Политика конфиденциальности' },
  { href: '/terms', label: 'Пользовательское соглашение' },
  { href: '/pricing', label: 'Тарифы и цены' },
  { href: '/contacts', label: 'Поддержка и контакты' },
]

export function H2({ children }: { children: ReactNode }) {
  return <h2 className="mt-9 text-[17.5px] font-bold tracking-tight text-white first:mt-0">{children}</h2>
}

export function P({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-[14.5px] leading-relaxed text-zinc-300">{children}</p>
}

export function LI({ children }: { children: ReactNode }) {
  return (
    <li className="mt-1.5 flex gap-2.5 text-[14.5px] leading-relaxed text-zinc-300">
      <span aria-hidden className="mt-[9px] block size-1 shrink-0 rounded-full bg-emerald-400/70" />
      <span>{children}</span>
    </li>
  )
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="mt-5 rounded-2xl border border-emerald-400/15 bg-emerald-400/[0.06] p-4 text-[13.5px] leading-relaxed text-emerald-100/90">
      {children}
    </div>
  )
}

export function LegalShell({
  title,
  subtitle,
  updated = DOCS_UPDATED,
  children,
}: {
  title: string
  subtitle?: string
  updated?: string
  children: ReactNode
}) {
  return (
    <div className="min-h-dvh bg-zinc-950 text-zinc-100 antialiased">
      {/* Шапка: бренд + возврат в приложение */}
      <header className="sticky top-0 z-10 border-b border-zinc-800/80 bg-zinc-950/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[760px] items-center justify-between px-5">
          <Link href="/" className="flex items-center gap-2.5 font-bold tracking-tight text-white">
            <span className="flex size-7 items-center justify-center rounded-lg bg-emerald-500 text-[13px] font-black text-zinc-950">
              T
            </span>
            <span className="text-[15.5px]">Tg Swipe</span>
          </Link>
          <a
            href={SITE_ORIGIN}
            className="rounded-full border border-zinc-700 px-3.5 py-1.5 text-[12.5px] font-medium text-zinc-300 transition-colors hover:border-emerald-400/40 hover:text-white"
          >
            Открыть приложение
          </a>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[760px] px-5 pb-14 pt-9">
        <h1 className="text-[26px] font-extrabold leading-tight tracking-tight text-white">{title}</h1>
        {subtitle ? <p className="mt-2 text-[14.5px] text-zinc-400">{subtitle}</p> : null}
        <p className="mt-2 text-[12.5px] uppercase tracking-wide text-zinc-500">
          Редакция от {updated}
        </p>
        <div className="mt-7">{children}</div>
      </main>

      {/* Подвал: навигация по документам, поддержка, кодовое слово */}
      <footer className="mt-6 border-t border-zinc-800/80 bg-zinc-900/40 pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto w-full max-w-[760px] px-5 py-8">
          <nav aria-label="Документы" className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {LEGAL_NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="text-[13.5px] text-zinc-400 transition-colors hover:text-emerald-300"
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <p className="mt-5 text-[13px] text-zinc-400">
            Поддержка:{' '}
            <a
              href="https://t.me/tgswipe_bot"
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-300 hover:underline"
            >
              @tgswipe_bot
            </a>{' '}
            · чат поддержки в приложении ·{' '}
            <a
              href="https://t.me/SnapTeamDev"
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-300 hover:underline"
            >
              канал новостей
            </a>
          </p>
          <p className="mt-4 text-[12px] text-zinc-600">© {new Date().getFullYear()} Tg Swipe</p>
          {/* ВРЕМЕННО (проверка владения проектом для Platega/банка) — убрать после согласования */}
          <p className="mt-1 text-[12px] text-zinc-600">Кодовое слово проверки: {CODE_WORD}</p>
        </div>
      </footer>
    </div>
  )
}
