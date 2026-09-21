import Link from 'next/link'
import { Compass } from 'lucide-react'

/**
 * Страница 404 (v5.57) — в стилистике миниаппа (токены темы),
 * вместо системной страницы Next.js. Ссылки на основные разделы.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-tg-bg px-8 text-center">
      <div
        className="flex size-24 items-center justify-center rounded-full bg-tg-link/10"
        aria-hidden
      >
        <Compass className="size-12 text-tg-link" strokeWidth={1.6} />
      </div>
      <h1 className="mt-6 text-[22px] font-bold tracking-tight text-tg-text">
        Страница не найдена
      </h1>
      <p className="mt-2 max-w-[320px] text-[14.5px] leading-relaxed text-tg-hint">
        Похоже, такой страницы нет — возможно, ссылка устарела или была введена с
        опечаткой.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/"
          className="flex min-h-[44px] items-center rounded-full bg-tg-link px-6 text-[15px] font-semibold text-white shadow-sm transition-transform active:scale-95"
        >
          В ленту
        </Link>
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
          {[
            ['/pricing', 'Тарифы'],
            ['/terms', 'Соглашение'],
            ['/privacy', 'Конфиденциальность'],
            ['/contacts', 'Поддержка'],
          ].map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className="text-[13px] text-tg-hint underline-offset-2 transition-colors hover:text-tg-link hover:underline"
            >
              {label}
            </Link>
          ))}
        </div>
      </div>
    </main>
  )
}
