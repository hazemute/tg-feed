import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Toaster } from '@/components/ui/sonner'

export const metadata: Metadata = {
  title: 'Tg Swipe · Админ-панель',
  description:
    'Локальная панель управления Tg Swipe: обзор, каналы, модерация, пользователи, реклама, инструменты, техработы.',
  robots: { index: false, follow: false },
}

// Корневой тостер мини-аппа (bottom-center, из src/app/layout.tsx) в админке
// не нужен — глушим его, здесь свой <Toaster> (bottom-right). Стили живут
// только пока смонтирован этот layout и сами убираются при уходе с /admin.
const hideRootToaster =
  "ol[data-sonner-toaster][data-x-position='center']{display:none!important}"

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <style dangerouslySetInnerHTML={{ __html: hideRootToaster }} />
      {children}
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  )
}
