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
 * ТЕМЫ АДМИНКИ (v5.11, приказ владельца: «сделай темную тему… либо тоже
 * палитры такие же как в миниаппе»). data-adm-theme ставится на корень
 * страницы (page.tsx), палитры повторяют миниапп: dark (Telegram), sepia,
 * rose. Светлая — базовая, без атрибута.
 *
 * Механика: компоненты админки используют tailwind-утилиты (bg-white,
 * text-slate-500…). Перекрываем их по селектору с атрибутом — специфичность
 * `[data-adm-theme=dark] .bg-white` выше одиночного класса, стили вне @layer
 * бьют layer-утилиты Tailwind — весь набор вкладок красится без правки 5000 строк.
 */
const adminThemes = `
[data-adm='dark']{--adm-page:#0e1621;--adm-panel:#17212b;--adm-elev:#232e3c;--adm-border:#2b3a4d;--adm-text:#eef3f8;--adm-text2:#c2d0df;--adm-mut:#9db0c4;--adm-dim:#7c93ab;--adm-acc:#62bcf9;--adm-acc-strong:#8fd0ff;--adm-acc-bg:#2e86c8;--adm-acc-soft:rgba(98,188,249,.13);--adm-warn:#f5b04d;--adm-warn-soft:rgba(245,176,77,.13);--adm-danger:#ff8d85;--adm-danger-bg:rgba(255,123,114,.13);--adm-chat:#0b131d;}
[data-adm='dark'] .bg-slate-50{background:#0e1621}
[data-adm='dark'] .bg-white{background:#17212b}
[data-adm='dark'] .bg-slate-100{background:#232e3c}
[data-adm='dark'] .bg-emerald-50,[data-adm='dark'] .bg-emerald-100{background:rgba(98,188,249,.13)}
[data-adm='dark'] .bg-emerald-400{background:#62bcf9}
[data-adm='dark'] .bg-emerald-500{background:#3fa3e8}
[data-adm='dark'] .bg-emerald-600,[data-adm='dark'] .hover\\\:bg-emerald-600:hover{background:#2e86c8}
[data-adm='dark'] .bg-emerald-700{background:#256da5}
[data-adm='dark'] .bg-amber-50,[data-adm='dark'] .bg-amber-100{background:rgba(245,176,77,.13)}
[data-adm='dark'] .bg-red-50{background:rgba(255,123,114,.13)}
[data-adm='dark'] .bg-red-100{background:rgba(255,123,114,.2)}
[data-adm='dark'] .bg-sky-100,[data-adm='dark'] .bg-sky-50{background:rgba(124,199,255,.13)}
[data-adm='dark'] .bg-background{background:#17212b}
[data-adm='dark'] .text-slate-900,[data-adm='dark'] .text-slate-950,[data-adm='dark'] .text-slate-800{color:#eef3f8}
[data-adm='dark'] .text-slate-700,[data-adm='dark'] .text-slate-600{color:#c2d0df}
[data-adm='dark'] .text-slate-500{color:#9db0c4}
[data-adm='dark'] .text-slate-400{color:#7c93ab}
[data-adm='dark'] .text-emerald-600,[data-adm='dark'] .text-emerald-700,[data-adm='dark'] .text-emerald-800{color:#8fd0ff}
[data-adm='dark'] .text-red-600,[data-adm='dark'] .text-red-700{color:#ff8d85}
[data-adm='dark'] .text-amber-600,[data-adm='dark'] .text-amber-700,[data-adm='dark'] .text-amber-500{color:#f5b04d}
[data-adm='dark'] .text-sky-600,[data-adm='dark'] .text-sky-700{color:#7cc7ff}
[data-adm='dark'] .text-violet-600,[data-adm='dark'] .text-violet-700{color:#c4a7ff}
[data-adm='dark'] .border-slate-100,[data-adm='dark'] .border-slate-200{border-color:#2b3a4d}
[data-adm='dark'] .border-emerald-200,[data-adm='dark'] .border-emerald-300{border-color:#2e5b7f}
[data-adm='dark'] .border-emerald-500\\\/30{border-color:rgba(98,188,249,.4)}
[data-adm='dark'] .border-red-200{border-color:#6e3a37}
[data-adm='dark'] .border-amber-200{border-color:#6e5433}
[data-adm='dark'] .border-sky-200{border-color:#2f5d80}
[data-adm='dark'] .border-violet-200{border-color:#564378}
[data-adm='dark'] .hover\\\:bg-slate-50:hover,[data-adm='dark'] .hover\\\:bg-slate-100:hover{background:#1a2530}
[data-adm='dark'] .hover\\\:bg-red-50:hover{background:rgba(255,123,114,.18)}
[data-adm='dark'] .hover\\\:bg-emerald-50:hover,[data-adm='dark'] .hover\\\:bg-emerald-100:hover{background:rgba(98,188,249,.18)}
[data-adm='dark'] .hover\\\:bg-emerald-400:hover{background:#62bcf9}
[data-adm='dark'] .hover\\\:bg-emerald-700:hover{background:#256da5}
[data-adm='dark'] .hover\\\:bg-red-500:hover{background:#e0554c}
[data-adm='dark'] .hover\\\:text-red-700:hover{color:#ff8d85}
[data-adm='dark'] .hover\\\:text-slate-900:hover,[data-adm='dark'] .hover\\\:text-emerald-700:hover{color:#8fd0ff}
[data-adm='dark'] .bg-\\\[\\\#eef1f5\\]{background:#0b131d}
[data-adm='dark'] .ring-slate-200{--tw-ring-color:#2b3a4d}
[data-adm='dark'] .focus\\\:border-emerald-400:focus{border-color:#62bcf9}
[data-adm='dark'] .focus\\\:ring-emerald-100{--tw-ring-color:rgba(98,188,249,.2)}
[data-adm='dark'] .shadow-sm{--tw-shadow-color:rgba(0,0,0,.4)}

[data-adm='sepia']{--adm-page:#f7f1e4;--adm-panel:#fffaf0;--adm-elev:#f0e6d2;--adm-border:#e5d9c3;--adm-text:#3a2e21;--adm-text2:#5d4c38;--adm-mut:#7d6b52;--adm-dim:#a08d6f;--adm-acc:#a8732f;--adm-acc-strong:#8a5a1f;--adm-acc-bg:#b47d33;--adm-acc-soft:rgba(168,115,47,.12);--adm-warn:#b47d33;--adm-danger:#c04a3a}
[data-adm='sepia'] .bg-slate-50{background:#f7f1e4}
[data-adm='sepia'] .bg-white{background:#fffaf0}
[data-adm='sepia'] .bg-slate-100{background:#f0e6d2}
[data-adm='sepia'] .bg-emerald-50,[data-adm='sepia'] .bg-emerald-100{background:rgba(168,115,47,.12)}
[data-adm='sepia'] .bg-emerald-500{background:#b47d33}
[data-adm='sepia'] .bg-emerald-600,[data-adm='sepia'] .bg-emerald-700{background:#a8732f}
[data-adm='sepia'] .bg-sky-100,[data-adm='sepia'] .bg-sky-50{background:rgba(168,115,47,.1)}
[data-adm='sepia'] .text-slate-900,[data-adm='sepia'] .text-slate-950,[data-adm='sepia'] .text-slate-800{color:#3a2e21}
[data-adm='sepia'] .text-slate-700,[data-adm='sepia'] .text-slate-600{color:#5d4c38}
[data-adm='sepia'] .text-slate-500{color:#7d6b52}
[data-adm='sepia'] .text-slate-400{color:#a08d6f}
[data-adm='sepia'] .text-emerald-600,[data-adm='sepia'] .text-emerald-700,[data-adm='sepia'] .text-emerald-800{color:#8a5a1f}
[data-adm='sepia'] .border-slate-100,[data-adm='sepia'] .border-slate-200{border-color:#e5d9c3}
[data-adm='sepia'] .hover\\\:bg-slate-50:hover,[data-adm='sepia'] .hover\\\:bg-slate-100:hover{background:#f0e6d2}
[data-adm='sepia'] .bg-\\\[\\\#eef1f5\\]{background:#f0e6d2}

[data-adm='rose']{--adm-page:#fdf2f4;--adm-panel:#fff;--adm-elev:#fbe4eb;--adm-border:#f2d9df;--adm-text:#3d2229;--adm-text2:#6b4049;--adm-mut:#9c6b76;--adm-dim:#c2949c;--adm-acc:#d4547a;--adm-acc-strong:#b83a61;--adm-acc-bg:#d4547a;--adm-acc-soft:rgba(212,84,122,.12);--adm-warn:#c07a3e;--adm-danger:#c0392b}
[data-adm='rose'] .bg-slate-50{background:#fdf2f4}
[data-adm='rose'] .bg-white{background:#fff}
[data-adm='rose'] .bg-slate-100{background:#fbe4eb}
[data-adm='rose'] .bg-emerald-50,[data-adm='rose'] .bg-emerald-100{background:rgba(212,84,122,.1)}
[data-adm='rose'] .bg-emerald-500{background:#d4547a}
[data-adm='rose'] .bg-emerald-600,[data-adm='rose'] .bg-emerald-700{background:#c04468}
[data-adm='rose'] .text-slate-900,[data-adm='rose'] .text-slate-950,[data-adm='rose'] .text-slate-800{color:#3d2229}
[data-adm='rose'] .text-slate-700,[data-adm='rose'] .text-slate-600{color:#6b4049}
[data-adm='rose'] .text-slate-500{color:#9c6b76}
[data-adm='rose'] .text-slate-400{color:#c2949c}
[data-adm='rose'] .text-emerald-600,[data-adm='rose'] .text-emerald-700,[data-adm='rose'] .text-emerald-800{color:#b83a61}
[data-adm='rose'] .border-slate-100,[data-adm='rose'] .border-slate-200{border-color:#f2d9df}
[data-adm='rose'] .hover\\\:bg-slate-50:hover,[data-adm='rose'] .hover\\\:bg-slate-100:hover{background:#fbe4eb}
[data-adm='rose'] .bg-\\\[\\\#eef1f5\\]{background:#fbe4eb}


[data-adm='dark'] .bg-white\\/90,[data-adm='dark'] .bg-white\\/80,[data-adm='dark'] .bg-white\\/70,[data-adm='dark'] .bg-white\\/50{background:rgba(23,33,43,.94)}
[data-adm='dark'] .bg-slate-50\\/70{background:rgba(16,27,39,.7)}
[data-adm='dark'] .bg-emerald-50\\/70{background:rgba(98,188,249,.1)}
[data-adm='dark'] .bg-emerald-50\\/50{background:rgba(98,188,249,.08)}
[data-adm='dark'] .bg-white\\/80{background:rgba(35,46,60,.9)}

/* Тумблер (Switch) и чекбоксы shadcn под палитрами */
[data-adm] [data-slot='switch']{outline:none}
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
