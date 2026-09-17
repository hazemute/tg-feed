import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { ThemeController } from './components/bits'

export const metadata: Metadata = {
  title: 'TG-Feed · Админ-панель',
  description:
    'Локальная панель управления TG-Feed: обзор, каналы, модерация, пользователи, реклама, инструменты.',
  robots: { index: false, follow: false },
}

// Тёмная тема должна примениться до первой отрисовки (shadcn-токены .dark).
const themeBoot = "try{document.documentElement.classList.add('dark')}catch(e){}"

// Корневой тостер мини-аппа (bottom-center, из src/app/layout.tsx) в админке
// не нужен — глушим его, здесь свой <Toaster> (bottom-right). Стили живут
// только пока смонтирован этот layout и сами убираются при уходе с /admin.
const hideRootToaster =
  "ol[data-sonner-toaster][data-x-position='center']{display:none!important}"

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#0e141c] text-slate-200" data-theme="dark">
      <ThemeController />
      <style dangerouslySetInnerHTML={{ __html: hideRootToaster }} />
      <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      {children}
      <Toaster theme="dark" position="bottom-right" richColors closeButton />
    </div>
  )
}
