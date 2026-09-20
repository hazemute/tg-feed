import type { MetadataRoute } from 'next'
import { SITE_NAME, SITE_URL } from '@/lib/site'

/**
 * PWA-манифест (v5.57): установка миниаппа/сайта на домашний экран,
 * корректная иконка в списке приложений и сплеш-фон.
 * Иконки сгенерированы из public/logo.svg (scripts/gen-icons.ts).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${SITE_NAME} — умная лента Telegram-каналов`,
    short_name: SITE_NAME,
    description:
      'Умная лента постов из открытых Telegram-каналов по вашим интересам: свайпы, AI-саммари, закладки и подписка в один тап.',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    lang: 'ru',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    categories: ['news', 'social'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/logo.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  }
}
