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
  title: 'Tg Swipe — умная лента Telegram-каналов',
  description:
    'Умная лента постов из открытых Telegram-каналов по вашим интересам: работает как сайт по домену и как Telegram Mini App. Подписка в один тап, AI-саммари, закладки.',
  keywords: ['Telegram', 'лента', 'каналы', 'Tg Swipe', 'сайт', 'Mini App'],
  icons: { icon: '/logo.svg' },
}

const themeInit = `try{var t=localStorage.getItem('tgfeed_theme')||'light';var f=localStorage.getItem('tgfeed_font');document.documentElement.dataset.theme=t;document.documentElement.dataset.fontscale=f||'md';var dk=['dark','mono','forest','ocean','midnight','plum','coffee','sunset','emerald','crimson','aurora','cherry'].indexOf(t)>=0;if(t==='auto')dk=!!(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',dk);}catch(e){document.documentElement.dataset.theme='light';}`

/*
 * Платформа до гидрации: 'web' (открыли по домену в браузере) или 'telegram'
 * (Mini App внутри клиента). SDK телеграма грузится раньше и синхронно
 * (classic script), поэтому к моменту запуска детектора window.Telegram уже
 * существует. Внутри Telegram initData непуст; вне — пуст и platform=unknown.
 * Раскладка ПК (полная ширина) вешается на html[data-platform='web'] в CSS.
 */
const platformInit = `try{var w=window.Telegram&&window.Telegram.WebApp;var p=(w&&(w.initData&&w.initData.length>0||w.platform&&w.platform!=='unknown'))?'telegram':'web';document.documentElement.dataset.platform=p;}catch(e){document.documentElement.dataset.platform='web';}`

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="ru"
      suppressHydrationWarning
      data-theme="light"
      data-fontscale="md"
      data-platform="telegram"
    >
      <head>
        {/* Предподключение к внешним источникам: аватарки каналов (Supabase
            Storage) — экономия TLS-хендшейка ~100-300мс на первом экране */}
        <link rel="preconnect" href={process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://supabase.co'} crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://cdn4.telesco.pe" />
        <link rel="dns-prefetch" href="https://cdn2.telesco.pe" />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <Script id="tgfeed-theme-init" strategy="beforeInteractive">
          {themeInit}
        </Script>
        {children}
        <Toaster position="bottom-center" offset={72} />
        {/*
          Telegram WebApp SDK — ОБЯЗАТЕЛЬНО до гидрации (beforeInteractive):
          authenticate() в useEffect читает window.Telegram.WebApp.initData на первом
          рендере. После Interactive (было) скрипт грузился ПОСЛЕ первого запроса —
          в Telegram Web/Desktop объект ещё не существовал, initData уходил пустым
          и ВСЕ пользователи становились гостями без профиля и аватара.
          ВАЖНО: SDK объявлен РАНЬШЕ детектора платформы — оба beforeInteractive
          исполняются по порядку появления, детектор уже видит window.Telegram.
        */}
        <Script
          src="https://telegram.org/js/telegram-web-app.js"
          strategy="beforeInteractive"
        />
        <Script id="tgfeed-platform-init" strategy="beforeInteractive">
          {platformInit}
        </Script>
      </body>
    </html>
  )
}
