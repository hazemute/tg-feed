import type { Metadata, Viewport } from 'next'
import Script from 'next/script'
import { Geist, Geist_Mono } from 'next/font/google'
import { Toaster } from '@/components/ui/sonner'
import { THEMES } from '@/lib/themes'
import {
  CUSTOM_BLEND_HINT,
  CUSTOM_BLEND_SURFACE,
  CUSTOM_BLEND_SURFACE2,
  CUSTOM_BLEND_TEXT2,
  CUSTOM_FG_DARK,
  CUSTOM_FG_LIGHT,
  CUSTOM_GREEN,
  CUSTOM_LUM_THRESHOLD,
  CUSTOM_SEP_DARK,
  CUSTOM_SEP_LIGHT,
  CUSTOM_STAR,
  CUSTOM_THEME_KEY,
} from '@/lib/custom-theme'
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

/*
 * themeInit (до гидрации): data-theme + data-fontscale + инлайн-vars кастомной
 * палитры + класс .dark — без вспышки белым при перезагрузке в тёмной/custom теме.
 *
 * v5.30: формулы derivation больше НЕ дублируются вручную — порог яркости, fg,
 * веса смешивания и служебные цвета ИНТЕРПОЛИРОВАНЫ из констант
 * src/lib/custom-theme.ts (единый источник правды). Список тёмных пресетов тоже
 * собирается из того же каталога THEMES, что галерея и isDarkPalette (раньше
 * дублировался руками и молча устаревал при добавлении палитры).
 *
 * v5.31 (фикс «кривой палитры» в auto): скрипт ИДЕМПОТЕНТЕН и исполняется ДВАЖДЫ —
 * до (первый прогон: мгновенная покраска без SDK) и СРАЗУ ПОСЛЕ telegram-web-app.js
 * (второй прогон: в миниаппе уже есть WebApp.themeParams/colorScheme):
 *  1) themeParams → --tg-theme-* ДО гидрации (та же карта, что в tg.ts
 *     syncTelegramThemeVars). Раньше [data-theme='auto'] до гидрации всегда падал
 *     в светлые фолбэки CSS, а .dark считался по prefers-color-scheme →
 *     «наполовину тёмный» UI и кривая палитра до первого эффекта page.tsx.
 *  2) auto внутри Telegram: .dark по colorScheme КЛИЕНТА (синхронно с
 *     resolveIsDark в page.tsx), а не по системному prefers-color-scheme.
 *  3) auto в браузере: data-theme сразу резолвится в конкретную светлую/тёмную
 *     палитру (синхронно с applyThemeDom) — нет вспышки light-фолбэков.
 * Вне миниаппы WebApp тоже существует (platform='unknown', initData пуст) —
 * это НЕ считается Telegram: проверка зеркалит platformInit ниже.
 */
const DARK_PRESET_IDS = JSON.stringify(THEMES.filter((t) => t.group === 'dark').map((t) => t.id))

const themeInit = `try{
var t=localStorage.getItem('tgfeed_theme')||'light';
var f=localStorage.getItem('tgfeed_font');
var h=document.documentElement;
h.dataset.theme=t;h.dataset.fontscale=f||'md';
/* Кастомная палитра (v5.28): vars из {bg,accent} ДО гидрации. */
var ct=null;try{ct=JSON.parse(localStorage.getItem('${CUSTOM_THEME_KEY}')||'null')}catch(e){}
var isHex=function(s){return typeof s==='string'&&/^#[0-9a-fA-F]{6}$/.test(s)};
var w=null;try{w=window.Telegram&&window.Telegram.WebApp||null}catch(e){}
var inTg=!!(w&&((w.initData&&w.initData.length>0)||(w.platform&&w.platform!=='unknown')));
/* themeParams → --tg-theme-* ДО гидрации (карта синхронна с tg.ts syncTelegramThemeVars) */
if(w&&w.themeParams){var tp=w.themeParams,st=h.style;
if(tp.bg_color)st.setProperty('--tg-theme-bg-color',tp.bg_color);
if(tp.text_color)st.setProperty('--tg-theme-text-color',tp.text_color);
if(tp.hint_color)st.setProperty('--tg-theme-hint-color',tp.hint_color);
if(tp.link_color)st.setProperty('--tg-theme-link-color',tp.link_color);
if(tp.button_color)st.setProperty('--tg-theme-button-color',tp.button_color);
if(tp.secondary_bg_color)st.setProperty('--tg-theme-secondary-bg-color',tp.secondary_bg_color);
if(tp.header_bg_color)st.setProperty('--tg-theme-header-bg-color',tp.header_bg_color);
if(tp.accent_text_color)st.setProperty('--tg-theme-accent-text-color',tp.accent_text_color);}
var dk=false;
if(t==='custom'&&ct&&isHex(ct.bg)&&isHex(ct.accent)){
  var hx=function(s){return[parseInt(s.slice(1,3),16),parseInt(s.slice(3,5),16),parseInt(s.slice(5,7),16)]};
  var mix=function(a,b,w){var x=hx(a),y=hx(b);return'#'+x.map(function(v,i){return Math.round(v+(y[i]-v)*w).toString(16).padStart(2,'0')}).join('')};
  /* Rec.709-яркость — коэффициенты синхронны с hexLum() в custom-theme.ts */
  var lum=function(s){var c=hx(s);return(0.2126*c[0]+0.7152*c[1]+0.0722*c[2])/255};
  var dark=lum(ct.bg)<${CUSTOM_LUM_THRESHOLD},fg=dark?'${CUSTOM_FG_DARK}':'${CUSTOM_FG_LIGHT}';
  var v=h.style;
  v.setProperty('--tg-bg',ct.bg);
  v.setProperty('--tg-surface',mix(ct.bg,fg,${CUSTOM_BLEND_SURFACE}));
  v.setProperty('--tg-surface2',mix(ct.bg,fg,${CUSTOM_BLEND_SURFACE2}));
  v.setProperty('--tg-text',fg);
  v.setProperty('--tg-text2',mix(fg,ct.bg,${CUSTOM_BLEND_TEXT2}));
  v.setProperty('--tg-hint',mix(fg,ct.bg,${CUSTOM_BLEND_HINT}));
  v.setProperty('--tg-link',ct.accent);
  v.setProperty('--tg-button',ct.accent);
  v.setProperty('--tg-like',ct.accent);
  v.setProperty('--tg-sep',dark?'${CUSTOM_SEP_DARK}':'${CUSTOM_SEP_LIGHT}');
  v.setProperty('--tg-green','${CUSTOM_GREEN}');
  v.setProperty('--tg-star','${CUSTOM_STAR}');
  dk=dark;
}else if(${DARK_PRESET_IDS}.indexOf(t)>=0){dk=true;}
else if(t==='auto'){
  if(inTg){dk=w.colorScheme==='dark';}
  else{
    var sd=!!(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);
    h.dataset.theme=sd?'dark':'light';dk=sd;
  }
}
h.classList.toggle('dark',dk);}catch(e){document.documentElement.dataset.theme='light';}`

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
        {/*
          Второй прогон themeInit СРАЗУ ПОСЛЕ SDK (both beforeInteractive →
          исполняются по порядку появления): в миниаппе к этому моменту уже
          доступны WebApp.themeParams/colorScheme — auto-тема и .dark досчитаются
          ДО гидрации, без «наполовину тёмного» окна между первым кадром и
          первым эффектом page.tsx. Скрипт идемпотентен: вне Telegram повторный
          прогон повторяет те же присвоения (пустые themeParams ничего не ставят).
        */}
        <Script id="tgfeed-theme-init-late" strategy="beforeInteractive">
          {themeInit}
        </Script>
        <Script id="tgfeed-platform-init" strategy="beforeInteractive">
          {platformInit}
        </Script>
      </body>
    </html>
  )
}
