import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Toaster } from '@/components/ui/sonner'

export const metadata: Metadata = {
  title: 'Tg Swipe · Админ-панель',
  description:
    'Панель управления Tg Swipe: обзор, финансы, каналы, модерация, пользователи, предложки, реклама, инструменты.',
  robots: { index: false, follow: false },
}

// Корневой тостер мини-аппа (bottom-center, из src/app/layout.tsx) в админке
// не нужен — глушим его, здесь свой <Toaster> (bottom-right). Стили живут
// только пока смонтирован этот layout и сами убираются при уходе с /admin.
const hideRootToaster =
  "ol[data-sonner-toaster][data-x-position='center']{display:none!important}"

/*
 * ТЕМЫ АДМИНКИ (v5.11 — приказ владельца: «сделай темную тему… либо тоже
 * палитры такие же как в миниаппе»; v5.62 — редизайн оболочки: тёмная
 * перелита в глубокий сине-сланцевый, светлая смягчена, добавлены оверрайды
 * sonner/switch/skeleton/скроллбаров и color-scheme).
 *
 * data-adm-theme ставится на корень страницы (page.tsx), data-adm — на <html>
 * (из page.tsx). Палитры повторяют миниапп: dark (Telegram), sepia, rose.
 * Светлая — базовая (data-adm-theme='light'), без атрибута на html.
 *
 * Механика: компоненты админки используют tailwind-утилиты (bg-white,
 * text-slate-500…). Перекрываем их по селектору с атрибутом — специфичность
 * `[data-adm-theme=dark] .bg-white` выше одиночного класса, стили вне @layer
 * бьют layer-утилиты Tailwind — весь набор вкладок красится без правки 5000 строк.
 *
 * ВАЖНО (v5.13): это template literal — бэкслеши экейпируются УДВОЕНИЕМ.
 * Класс .hover\:bg-slate-50 в CSS пишется как .hover\\:bg-slate-50 здесь.
 * Кроме палитры-переменных (--adm-*) перекрываются и shadcn-токены
 * (--primary/--accent/--input/--ring/--card/--popover/--muted/--border) —
 * чекбоксы, свитчи, Progress, Skeleton, popover'ы Select/Dialog и подсветка
 * Select-опций красятся в тему без доп. правил.
 */
const adminThemes = `
/* color-scheme: нативные контролы (скроллбары, даты, селекты ОС) под тему */
[data-adm-theme]{color-scheme:light}
[data-adm-theme='dark']{color-scheme:dark}

[data-adm='dark']{color-scheme:dark;--adm-page:#0b1119;--adm-panel:#111a24;--adm-elev:#182430;--adm-border:#223145;--adm-text:#e8eef5;--adm-text2:#c3d0de;--adm-mut:#8ea1b5;--adm-dim:#6e8399;--adm-acc:#62bcf9;--adm-acc-strong:#8fd0ff;--adm-acc-bg:#2e86c8;--adm-acc-soft:rgba(98,188,249,.13);--adm-warn:#f5b04d;--adm-warn-soft:rgba(245,176,77,.13);--adm-danger:#ff8d85;--adm-danger-bg:rgba(255,123,114,.13);--adm-chat:#0a1017;--background:#0b1119;--foreground:#e8eef5;--card:#111a24;--card-foreground:#e8eef5;--popover:#182430;--popover-foreground:#e8eef5;--primary:#62bcf9;--primary-foreground:#0b1119;--secondary:#182430;--secondary-foreground:#c3d0de;--muted:#182430;--muted-foreground:#8ea1b5;--accent:#1c2938;--accent-foreground:#e8eef5;--input:#33465e;--border:#223145;--ring:#62bcf9}
[data-adm='dark'] .bg-slate-50{background:#0b1119}
[data-adm='dark'] .bg-white{background:#111a24}
[data-adm='dark'] .bg-slate-100{background:#182430}
[data-adm='dark'] .bg-slate-200{background:#223145}
[data-adm='dark'] .bg-slate-50\\/60{background:rgba(11,17,25,.6)}
[data-adm='dark'] .bg-emerald-50,[data-adm='dark'] .bg-emerald-100{background:rgba(98,188,249,.13)}
[data-adm='dark'] .bg-emerald-400{background:#62bcf9}
[data-adm='dark'] .bg-emerald-500{background:#3fa3e8}
[data-adm='dark'] .bg-emerald-600,[data-adm='dark'] .hover\\\:bg-emerald-600:hover{background:#2e86c8}
[data-adm='dark'] .bg-emerald-700{background:#256da5}
[data-adm='dark'] .bg-amber-50,[data-adm='dark'] .bg-amber-100{background:rgba(245,176,77,.13)}
[data-adm='dark'] .bg-red-50{background:rgba(255,123,114,.13)}
[data-adm='dark'] .bg-red-100{background:rgba(255,123,114,.2)}
[data-adm='dark'] .bg-sky-100,[data-adm='dark'] .bg-sky-50{background:rgba(124,199,255,.13)}
[data-adm='dark'] .bg-background{background:#111a24}
[data-adm='dark'] .text-slate-900,[data-adm='dark'] .text-slate-950,[data-adm='dark'] .text-slate-800{color:#e8eef5}
[data-adm='dark'] .text-slate-700,[data-adm='dark'] .text-slate-600{color:#c3d0de}
[data-adm='dark'] .text-slate-500{color:#8ea1b5}
[data-adm='dark'] .text-slate-300{color:#566b82}
[data-adm='dark'] .text-slate-400{color:#6e8399}
[data-adm='dark'] .text-emerald-600,[data-adm='dark'] .text-emerald-700,[data-adm='dark'] .text-emerald-800{color:#8fd0ff}
[data-adm='dark'] .text-red-600,[data-adm='dark'] .text-red-700{color:#ff8d85}
[data-adm='dark'] .text-amber-600,[data-adm='dark'] .text-amber-700,[data-adm='dark'] .text-amber-500,[data-adm='dark'] .text-amber-800{color:#f5b04d}
[data-adm='dark'] .text-sky-600,[data-adm='dark'] .text-sky-700{color:#7cc7ff}
[data-adm='dark'] .text-violet-600,[data-adm='dark'] .text-violet-700{color:#c4a7ff}
[data-adm='dark'] .border-slate-50{border-color:#182231}
[data-adm='dark'] .border-slate-100,[data-adm='dark'] .border-slate-200{border-color:#223145}
[data-adm='dark'] .border-emerald-200,[data-adm='dark'] .border-emerald-300{border-color:#2e5b7f}
[data-adm='dark'] .border-emerald-500\\\/30{border-color:rgba(98,188,249,.4)}
[data-adm='dark'] .border-red-200{border-color:#6e3a37}
[data-adm='dark'] .border-amber-200{border-color:#6e5433}
[data-adm='dark'] .border-amber-300{border-color:#6e5433}
[data-adm='dark'] .ring-amber-200{--tw-ring-color:#6e5433}
[data-adm='dark'] .ring-offset-1{--tw-ring-offset-color:#111a24}
[data-adm='dark'] .border-sky-200{border-color:#2f5d80}
[data-adm='dark'] .border-violet-200{border-color:#564378}
[data-adm='dark'] .hover\\\:bg-slate-50:hover,[data-adm='dark'] .hover\\\:bg-slate-100:hover{background:#17222e}
[data-adm='dark'] .hover\\\:bg-slate-200\\/70:hover{background:#1c2836}
[data-adm='dark'] .hover\\\:bg-white:hover{background:#182430}
[data-adm='dark'] .hover\\\:bg-amber-50:hover{background:rgba(245,176,77,.15)}
[data-adm='dark'] .hover\\\:bg-sky-50:hover{background:rgba(124,199,255,.14)}
[data-adm='dark'] .hover\\\:bg-violet-50:hover{background:rgba(196,167,255,.14)}
[data-adm='dark'] .hover\\\:bg-red-50:hover{background:rgba(255,123,114,.18)}
[data-adm='dark'] .hover\\\:bg-emerald-50:hover,[data-adm='dark'] .hover\\\:bg-emerald-100:hover{background:rgba(98,188,249,.18)}
[data-adm='dark'] .hover\\\:bg-emerald-400:hover{background:#62bcf9}
[data-adm='dark'] .hover\\\:bg-emerald-700:hover{background:#256da5}
[data-adm='dark'] .hover\\\:bg-red-500:hover{background:#e0554c}
[data-adm='dark'] .hover\\\:text-red-700:hover{color:#ff8d85}
[data-adm='dark'] .hover\\\:text-slate-900:hover,[data-adm='dark'] .hover\\\:text-emerald-700:hover{color:#8fd0ff}
[data-adm='dark'] .bg-\\\[\\\#eef1f5\\\]{background:#0b1119}
[data-adm='dark'] .disabled\\\:bg-slate-50:disabled{background:#0b1119}
[data-adm='dark'] .placeholder\\\:text-slate-500::placeholder{color:#6e8399}
[data-adm='dark'] .ring-slate-200{--tw-ring-color:#223145}
[data-adm='dark'] .focus\\\:border-emerald-400:focus{border-color:#62bcf9}
[data-adm='dark'] .focus\\\:ring-emerald-100{--tw-ring-color:rgba(98,188,249,.2)}
[data-adm='dark'] .shadow-sm{--tw-shadow-color:rgba(0,0,0,.45)}
[data-adm='dark'] .bg-white\\/90,[data-adm='dark'] .bg-white\\/80,[data-adm='dark'] .bg-white\\/70,[data-adm='dark'] .bg-white\\/50{background:rgba(17,26,36,.95)}
[data-adm='dark'] .bg-slate-50\\/70{background:rgba(13,20,30,.7)}
[data-adm='dark'] .bg-emerald-50\\/70{background:rgba(98,188,249,.1)}
[data-adm='dark'] .bg-emerald-50\\/50{background:rgba(98,188,249,.08)}
[data-adm='dark'] .bg-white\\/80{background:rgba(24,36,48,.9)}

/* v5.62: Switch — включённое состояние = акцент, выключенное — читаемый трек */
[data-adm='dark'] [data-slot='switch'][data-state='checked']{background:var(--adm-acc)}
[data-adm='dark'] [data-slot='switch'][data-state='unchecked']{background:#2a3a4e;border-color:#33465e}

/* v5.62: Skeleton — приподнятый сланец вместо почти чёрного */
[data-adm='dark'] [data-slot='skeleton']{background:#1c2938}

/* v5.62: тосты sonner в тёмной теме — панельный фон/граница/текст, цветная
 * иконка по типу (richColors sonner перебивается !important — его селекторы
 * с [data-rich-colors] выше по специфичности) */
[data-adm='dark'] [data-sonner-toaster]{--normal-bg:#182430;--normal-text:#e8eef5;--normal-border:#223145}
[data-adm='dark'] [data-sonner-toast]{background:#182430!important;border:1px solid #223145!important;color:#e8eef5!important;box-shadow:0 12px 32px rgba(2,8,20,.55)!important}
[data-adm='dark'] [data-sonner-toast] [data-title]{color:#e8eef5!important}
[data-adm='dark'] [data-sonner-toast] [data-description]{color:#8ea1b5!important}
[data-adm='dark'] [data-sonner-toast] [data-icon]{color:var(--adm-acc-strong)!important}
[data-adm='dark'] [data-sonner-toast][data-type='success'] [data-icon]{color:#4ade80!important}
[data-adm='dark'] [data-sonner-toast][data-type='error'] [data-icon]{color:#ff8d85!important}
[data-adm='dark'] [data-sonner-toast][data-type='warning'] [data-icon]{color:#f5b04d!important}
[data-adm='dark'] [data-sonner-toast][data-type='info'] [data-icon]{color:#62bcf9!important}
[data-adm='dark'] [data-sonner-toast] [data-close-button]{background:#223145!important;border:1px solid #2c3f57!important;color:#c3d0de!important}

[data-adm='sepia']{--adm-page:#f7f1e4;--adm-panel:#fffaf0;--adm-elev:#f0e6d2;--adm-border:#e5d9c3;--adm-text:#3a2e21;--adm-text2:#5d4c38;--adm-mut:#7d6b52;--adm-dim:#a08d6f;--adm-acc:#a8732f;--adm-acc-strong:#8a5a1f;--adm-acc-bg:#b47d33;--adm-acc-soft:rgba(168,115,47,.12);--adm-warn:#b47d33;--adm-danger:#c04a3a;--background:#f7f1e4;--foreground:#3a2e21;--card:#fffaf0;--card-foreground:#3a2e21;--popover:#fffaf0;--popover-foreground:#3a2e21;--muted:#f0e6d2;--muted-foreground:#7d6b52;--primary:#a8732f;--primary-foreground:#fffaf0;--accent:#f0e6d2;--accent-foreground:#3a2e21;--input:#e5d9c3;--border:#e5d9c3;--ring:#a8732f}
[data-adm='sepia'] .bg-slate-50{background:#f7f1e4}
[data-adm='sepia'] .bg-white{background:#fffaf0}
[data-adm='sepia'] .bg-slate-100{background:#f0e6d2}
[data-adm='sepia'] .bg-slate-200{background:#e5d9c3}
[data-adm='sepia'] .bg-emerald-50,[data-adm='sepia'] .bg-emerald-100{background:rgba(168,115,47,.12)}
[data-adm='sepia'] .bg-emerald-500{background:#b47d33}
[data-adm='sepia'] .bg-emerald-600,[data-adm='sepia'] .bg-emerald-700{background:#a8732f}
[data-adm='sepia'] .bg-sky-100,[data-adm='sepia'] .bg-sky-50{background:rgba(168,115,47,.1)}
[data-adm='sepia'] .text-slate-900,[data-adm='sepia'] .text-slate-950,[data-adm='sepia'] .text-slate-800{color:#3a2e21}
[data-adm='sepia'] .text-slate-700,[data-adm='sepia'] .text-slate-600{color:#5d4c38}
[data-adm='sepia'] .text-slate-500{color:#7d6b52}
[data-adm='sepia'] .text-slate-400{color:#a08d6f}
[data-adm='sepia'] .text-emerald-600,[data-adm='sepia'] .text-emerald-700,[data-adm='sepia'] .text-emerald-800{color:#8a5a1f}
[data-adm='sepia'] .border-slate-50{border-color:#efe4cf}
[data-adm='sepia'] .border-slate-100,[data-adm='sepia'] .border-slate-200{border-color:#e5d9c3}
[data-adm='sepia'] .bg-white\\/90{background:rgba(255,250,240,.92)}
[data-adm='sepia'] .hover\\\:bg-slate-50:hover,[data-adm='sepia'] .hover\\\:bg-slate-100:hover{background:#f0e6d2}
[data-adm='sepia'] .bg-\\\[\\\#eef1f5\\\]{background:#f0e6d2}
[data-adm='sepia'] .placeholder\\\:text-slate-500::placeholder{color:#7d6b52}

[data-adm='rose']{--adm-page:#fdf2f4;--adm-panel:#fff;--adm-elev:#fbe4eb;--adm-border:#f2d9df;--adm-text:#3d2229;--adm-text2:#6b4049;--adm-mut:#9c6b76;--adm-dim:#c2949c;--adm-acc:#d4547a;--adm-acc-strong:#b83a61;--adm-acc-bg:#d4547a;--adm-acc-soft:rgba(212,84,122,.12);--adm-warn:#c07a3e;--adm-danger:#c0392b;--background:#fdf2f4;--foreground:#3d2229;--card:#ffffff;--card-foreground:#3d2229;--popover:#ffffff;--popover-foreground:#3d2229;--muted:#fbe4eb;--muted-foreground:#9c6b76;--primary:#d4547a;--primary-foreground:#ffffff;--accent:#fbe4eb;--accent-foreground:#3d2229;--input:#f2d9df;--border:#f2d9df;--ring:#d4547a}
[data-adm='rose'] .bg-slate-50{background:#fdf2f4}
[data-adm='rose'] .bg-white{background:#fff}
[data-adm='rose'] .bg-slate-100{background:#fbe4eb}
[data-adm='rose'] .bg-slate-200{background:#f4dfe5}
[data-adm='rose'] .bg-emerald-50,[data-adm='rose'] .bg-emerald-100{background:rgba(212,84,122,.1)}
[data-adm='rose'] .bg-emerald-500{background:#d4547a}
[data-adm='rose'] .bg-emerald-600,[data-adm='rose'] .bg-emerald-700{background:#c04468}
[data-adm='rose'] .text-slate-900,[data-adm='rose'] .text-slate-950,[data-adm='rose'] .text-slate-800{color:#3d2229}
[data-adm='rose'] .text-slate-700,[data-adm='rose'] .text-slate-600{color:#6b4049}
[data-adm='rose'] .text-slate-500{color:#9c6b76}
[data-adm='rose'] .text-slate-400{color:#c2949c}
[data-adm='rose'] .text-emerald-600,[data-adm='rose'] .text-emerald-700,[data-adm='rose'] .text-emerald-800{color:#b83a61}
[data-adm='rose'] .border-slate-50{border-color:#f7e9ec}
[data-adm='rose'] .border-slate-100,[data-adm='rose'] .border-slate-200{border-color:#f2d9df}
[data-adm='rose'] .bg-white\\/90{background:rgba(255,255,255,.92)}
[data-adm='rose'] .hover\\\:bg-slate-50:hover,[data-adm='rose'] .hover\\\:bg-slate-100:hover{background:#fbe4eb}
[data-adm='rose'] .bg-\\\[\\\#eef1f5\\\]{background:#fbe4eb}
[data-adm='rose'] .placeholder\\\:text-slate-500::placeholder{color:#9c6b76}

/* v5.62: светлая — чуть мягче чистого slate: страница #f3f5f9, границы #e6eaf0 */
[data-adm-theme='light'] .bg-slate-50{background:#f3f5f9}
[data-adm-theme='light'] .border-slate-200{border-color:#e6eaf0}
[data-adm-theme='light'] .border-slate-100{border-color:#edf0f5}

/* v5.62: тонкие скроллбары админки — только внутри .admin-scroll (глобальное
 * «прятать все скроллбары» из globals.css здесь намеренно перекрывается:
 * специфичность выше универсального селектора). Тонкие, скруглённые, сланцевые. */
[data-adm-theme] .admin-scroll{scrollbar-width:thin;scrollbar-color:rgba(100,116,139,.4) transparent}
[data-adm-theme] .admin-scroll::-webkit-scrollbar{display:block;width:8px;height:8px}
[data-adm-theme] .admin-scroll::-webkit-scrollbar-track{background:transparent}
[data-adm-theme] .admin-scroll::-webkit-scrollbar-thumb{border-radius:9999px;background:rgba(100,116,139,.35)}
[data-adm-theme] .admin-scroll::-webkit-scrollbar-thumb:hover{background:rgba(100,116,139,.55)}
[data-adm-theme='dark'] .admin-scroll{scrollbar-color:rgba(142,161,181,.32) transparent}
[data-adm-theme='dark'] .admin-scroll::-webkit-scrollbar-thumb{background:rgba(142,161,181,.32)}
[data-adm-theme='dark'] .admin-scroll::-webkit-scrollbar-thumb:hover{background:rgba(142,161,181,.5)}

[data-adm] [data-slot='switch']{outline:none}

/* v5.21: маппинг tg-* переменных миниаппа → палитры админки. ChatInput
 * (слитое поле «микрофон ⇄ отправка») используется в ответах поддержки,
 * поэтому темы панели красят и его без правок компонента. */
[data-adm-theme]{--tg-bg:var(--adm-page);--tg-surface:var(--adm-elev);--tg-surface2:var(--adm-panel);--tg-sep:var(--adm-border);--tg-text:var(--adm-text);--tg-text2:var(--adm-text2);--tg-hint:var(--adm-mut);--tg-link:var(--adm-acc);--tg-like:var(--adm-danger);--tg-star:var(--adm-warn);}
[data-adm-theme='light']{--tg-bg:#ffffff;--tg-surface:#f1f5f9;--tg-surface2:#e2e8f0;--tg-sep:#e2e8f0;--tg-text:#0f172a;--tg-text2:#334155;--tg-hint:#64748b;--tg-link:#0284c7;--tg-like:#dc2626;--tg-star:#d97706}
[data-adm-theme='dark']{--tg-bg:#0b1119;--tg-surface:#182430;--tg-surface2:#223145;--tg-sep:#223145;--tg-text:#e8eef5;--tg-text2:#c3d0de;--tg-hint:#8ea1b5;--tg-link:#62bcf9;--tg-like:#ff8d85;--tg-star:#f5b04d}
[data-adm-theme='sepia']{--tg-bg:#f7f1e4;--tg-surface:#f0e6d2;--tg-surface2:#e5d9c3;--tg-sep:#e5d9c3;--tg-text:#3a2e21;--tg-text2:#5d4c38;--tg-hint:#7d6b52;--tg-link:#a8732f;--tg-like:#c04a3a;--tg-star:#b47d33}
[data-adm-theme='rose']{--tg-bg:#fdf2f6;--tg-surface:#fbe4ee;--tg-surface2:#f5d3e3;--tg-sep:#f0c9dc;--tg-text:#4a2437;--tg-text2:#6d3a52;--tg-hint:#a06e88;--tg-link:#d6336c;--tg-like:#e03131;--tg-star:#f59f00}
body:has([data-adm-theme]){--tg-bg:#ffffff;--tg-surface:#f1f5f9;--tg-surface2:#e2e8f0;--tg-sep:#e2e8f0;--tg-text:#0f172a;--tg-text2:#334155;--tg-hint:#64748b;--tg-link:#0284c7;--tg-like:#dc2626;--tg-star:#d97706}
`

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <style dangerouslySetInnerHTML={{ __html: hideRootToaster + adminThemes }} />
      {children}
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  )
}
