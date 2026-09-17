import type { Metadata, Viewport } from 'next'
import Script from 'next/script'
import { Geist, Geist_Mono } from 'next/font/google'
import { Toaster } from '@/components/ui/sonner'
import './globals.css'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin', 'cyrillic'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin', 'cyrillic'],
})

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#ffffff',
}

export const metadata: Metadata = {
  title: 'TG-Feed — умная лента Telegram-каналов',
  description:
    'Telegram Mini App: бесконечная лента постов из открытых Telegram-каналов по вашим интересам. Подписка в один тап, AI-саммари, закладки.',
  keywords: ['Telegram', 'Mini App', 'лента', 'каналы', 'TG-Feed'],
  icons: { icon: '/logo.svg' },
}

const themeInit = `try{var t=localStorage.getItem('tgfeed_theme');var f=localStorage.getItem('tgfeed_font');document.documentElement.dataset.theme=t||'light';document.documentElement.dataset.fontscale=f||'md';}catch(e){document.documentElement.dataset.theme='light';}`

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="ru" suppressHydrationWarning data-theme="light" data-fontscale="md">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <Script id="tgfeed-theme-init" strategy="beforeInteractive">
          {themeInit}
        </Script>
        {children}
        <Toaster position="bottom-center" offset={72} />
        {/* Telegram WebApp SDK (вне Telegram просто не загрузится) */}
        <Script src="https://telegram.org/js/telegram-web-app.js" strategy="afterInteractive" />
      </body>
    </html>
  )
}
