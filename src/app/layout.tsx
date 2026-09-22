import type { Metadata, Viewport } from 'next'
import Script from 'next/script'
import { Geist, Geist_Mono } from 'next/font/google'
import { BootShellDismiss } from '@/components/boot-shell-dismiss'
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
import { SITE_URL } from '@/lib/site'

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
  // v5.57: цвет интерфейса браузера под светлую/тёмную схему (раньше был
  // жёстко белый — в тёмной теме шапка браузера слепила)
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0e141c' },
  ],
}

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Tg Swipe — умная лента Telegram-каналов',
  description:
    'Умная лента постов из открытых Telegram-каналов: работает как сайт по домену и как Telegram Mini App. Подписка в один тап, AI-саммари, закладки.',
  keywords: ['Telegram', 'лента', 'каналы', 'Tg Swipe', 'сайт', 'Mini App'],
  applicationName: 'Tg Swipe',
  manifest: '/manifest.webmanifest',
  alternates: { canonical: '/' },
  icons: {
    icon: [
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/logo.svg', type: 'image/svg+xml' },
    ],
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    type: 'website',
    locale: 'ru_RU',
    url: SITE_URL,
    siteName: 'Tg Swipe',
    title: 'Tg Swipe — умная лента Telegram-каналов',
    description:
      'Игровая лента: свайпы, AI-саммари, закладки. Работает как сайт и как Telegram Mini App.',
    images: [
      {
        url: '/tgswipe-welcome.png',
        width: 1200,
        height: 630,
        alt: 'Tg Swipe — умная лента Telegram-каналов',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Tg Swipe — умная лента Telegram-каналов',
    description:
      'Игровая лента: свайпы, AI-саммари, закладки.',
    images: ['/tgswipe-welcome.png'],
  },
  appleWebApp: {
    capable: true,
    title: 'Tg Swipe',
    statusBarStyle: 'default',
  },
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
+ `;try{window.__bootShell&&window.__bootShell.tint()}catch(e){}`

/*
 * v5.84 BOOT GUARD — страховка от «пустого экрана» (баг: серая пустота в
 * Telegram Desktop вместо приложения). Причина: WebView держит устаревший
 * HTML → ссылки на чанки прошлого деплоя дают 404 → ни один скрипт не
 * запускается → React никогда не монтируется, а существующие экраны ошибок
 * (page.tsx, error.tsx) сами живут в React и не могут показаться.
 *
 * Этот инлайн-скрипт исполняется ИЗ HTML (сеть не нужна, до гидрации):
 *  1) мгновенно рисует брендированную шторку (лого + спиннер) вместо пустоты;
 *  2) ловит ошибки загрузки script/link (404 чанков после деплоя) и один раз
 *     за 45с автоматически перезагружает страницу — свежий HTML тянет свежие
 *     чанки, приложение самолечится без участия пользователя;
 *  3) ватчдог: 8с — «Медленное соединение…», 14с — кнопка «Перезагрузить»
 *     (мин. 44px, тач-стандарт). Если React всё же поднялся — page.tsx
 *     вызывает hideBootShell() в первом эффекте: шторка гаснет и таймеры
 *     отменяются, пользователь кнопку не видит.
 *
 * Шторка создаётся скриптом (НЕ статичным HTML), поэтому React ею не
 * управляет и hydration-mismatch невозможен. ВАЖНО: это РАСШИРЕННЫЙ <script>
 * в JSX, а НЕ next/script — beforeInteractive-скрипты Next исполняет из
 * __next_s (flight-данных) КОДОМ ВНУТРИ ЧАНКОВ, которого при 404 чанков нет.
 * Сырой <script> исполняется браузером прямо из HTML — работает всегда.
 * Цвета: CSS-переменные themeInit (здоровый бут) → фолбэк на localStorage
 * (битый бут: __next_s не исполнился) → светлая/тёмная константа.
 */
const bootGuard = `try{
(function(){
  if(document.getElementById('tgfeed-boot-shell'))return;
  var h=document.documentElement;
  var st=document.createElement('style');
  st.id='tgfeed-boot-style';
  st.textContent='@keyframes tgfeed-boot-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){#tgfeed-boot-shell *{animation:none!important}}';
  (document.head||h).appendChild(st);
  var s=document.createElement('div');
  s.id='tgfeed-boot-shell';
  s.setAttribute('role','status');
  s.style.cssText='position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;transition:opacity .3s ease;user-select:none;-webkit-user-select:none';
  var icon=document.createElement('div');
  icon.style.cssText='width:80px;height:80px;border-radius:24px;display:flex;align-items:center;justify-content:center;box-shadow:0 14px 36px rgba(41,169,235,.32)';
  icon.innerHTML='<svg width="42" height="42" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M21.9 3.1 2.9 10.6c-.95.37-.9 1.72.08 2l4.86 1.44 1.7 5.5c.28.9 1.45 1.05 1.95.25l2.5-4.1 4.9 3.6c.75.55 1.82.14 2-.78l3.1-14.1c.2-.94-.72-1.72-1.6-1.38Z" fill="#fff"/></svg>';
  var spin=document.createElement('div');
  spin.style.cssText='width:26px;height:26px;border-radius:50%;border:3px solid rgba(125,135,150,.22)';
  var msg=document.createElement('div');
  msg.style.cssText='font-size:13px;line-height:1.5;text-align:center;max-width:280px;min-height:20px;padding:0 16px';
  s.appendChild(icon);s.appendChild(spin);s.appendChild(msg);
  (document.body||h).appendChild(s);
  var accentVal='#29a9eb';
  var DARKS=${DARK_PRESET_IDS};
  var tint=function(){
    try{
      var dark=h.classList.contains('dark');
      var acc='';var bg='';
      try{acc=getComputedStyle(h).getPropertyValue('--tg-theme-button-color').trim()}catch(e){}
      try{bg=getComputedStyle(h).getPropertyValue('--tg-theme-bg-color').trim()}catch(e){}
      if(!bg||!acc){
        var t='';try{t=localStorage.getItem('tgfeed_theme')||''}catch(e){}
        if(!bg&&t==='custom'){
          var ct=null;try{ct=JSON.parse(localStorage.getItem('${CUSTOM_THEME_KEY}')||'null')}catch(e){}
          if(ct&&/^#[0-9a-fA-F]{6}$/.test(ct.bg||'')){
            bg=ct.bg;
            var c=[parseInt(ct.bg.slice(1,3),16),parseInt(ct.bg.slice(3,5),16),parseInt(ct.bg.slice(5,7),16)];
            dark=(0.2126*c[0]+0.7152*c[1]+0.0722*c[2])/255<${CUSTOM_LUM_THRESHOLD};
          }
        }
        if(!bg)bg=DARKS.indexOf(t)>=0||dark?'#0e141c':'#ffffff';
      }
      if(!acc)acc=dark?'#3ba3d6':'#29a9eb';
      accentVal=acc;
      s.style.background=bg;
      icon.style.background=acc;
      icon.style.boxShadow='0 14px 36px '+(dark?'rgba(0,0,0,.45)':'rgba(41,169,235,.32)');
      spin.style.borderTopColor=acc;
      msg.style.color=dark?'#98a2b3':'#6b7280';
    }catch(e){}
  };
  tint();
  var T=[];var w=window;w.__bootShellTimers=T;
  var hidden=false;
  var hide=function(){
    if(hidden)return;hidden=true;
    try{
      s.style.opacity='0';s.style.pointerEvents='none';
      setTimeout(function(){if(s.parentNode)s.parentNode.removeChild(s)},350);
    }catch(e){}
  };
  w.__bootShell={hide:hide,tint:tint};
  var guardReload=function(){
    try{
      var last=Number(sessionStorage.getItem('tgfeed_boot_reload_at')||0);
      if(Date.now()-last<45000)return;
      sessionStorage.setItem('tgfeed_boot_reload_at',String(Date.now()));
      location.reload();
    }catch(e){}
  };
  /* 404 чанков прошлого деплоя: ошибка ресурса в capture-фазе */
  window.addEventListener('error',function(ev){
    try{
      var t=ev.target;if(!t||!t.tagName)return;
      var tag=t.tagName.toUpperCase();
      if(tag!=='SCRIPT'&&tag!=='LINK')return;
      guardReload();
    }catch(e){}
  },true);
  /* Часть браузеров кидает ошибку чанка как unhandledrejection */
  var chunkRe=/Loading chunk \\d+ failed|ChunkLoadError|dynamically imported module|Importing a module script failed/i;
  window.addEventListener('unhandledrejection',function(ev){
    try{
      var r=ev&&ev.reason;var m=r&&(r.message||String(r));
      if(m&&chunkRe.test(m))guardReload();
    }catch(e){}
  });
  /* Ватчдог: не мешаем нормальной загрузке — просто честный статус */
  T.push(setTimeout(function(){try{if(!hidden)msg.textContent='Медленное соединение…'}catch(e){}},8000));
  T.push(setTimeout(function(){
    try{
      if(hidden)return;
      msg.textContent='';
      var b=document.createElement('button');
      b.type='button';
      b.textContent='Перезагрузить';
      b.setAttribute('aria-label','Перезагрузить приложение');
      b.style.cssText='min-height:44px;padding:0 26px;border:none;border-radius:999px;font-size:15px;font-weight:600;color:#fff;cursor:pointer;background:'+accentVal;
      b.onclick=function(){try{sessionStorage.setItem('tgfeed_boot_reload_at',String(Date.now()))}catch(e){}location.reload()};
      msg.appendChild(b);
      var hint=document.createElement('div');
      hint.style.cssText='font-size:12px;margin-top:2px';
      hint.textContent='Страница загрузилась не полностью';
      msg.appendChild(hint);
    }catch(e){}
  },14000));
})();
}catch(e){}`

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
        {/* v5.57: предподключение к Telegram CDN (аватарки каналов теперь
            отдаются прямыми ссылками telesco.pe) — TLS-хендшейк экономится
            ~100-300мс на первом экране. Мёртвый preconnect Supabase убран. */}
        <link rel="preconnect" href="https://cdn4.telesco.pe" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://cdn2.telesco.pe" />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {/*
          v5.84 BOOT GUARD — ПЕРВЫМ делом, РАСШИРЕННЫЙ <script> (не next/script!):
          beforeInteractive-инлайны Next исполняет кодом из чанков (__next_s),
          которого при 404 чанков нет — а этот тег браузер исполняет прямо из
          HTML. Рисует шторку загрузки и чинит авто-перезагрузку при 404 чанков
          (см. комментарий у bootGuard выше).
        */}
        <script dangerouslySetInnerHTML={{ __html: bootGuard }} />
        {/* v5.86: React смонтировался → шторка гаснет на ЛЮБОМ маршруте
            (раньше только page.tsx умел — /admin вечно показывал сплэш) */}
        <BootShellDismiss />
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
