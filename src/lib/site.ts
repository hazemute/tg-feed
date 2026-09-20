/**
 * Единый публичный адрес сервиса (v5.57).
 * metadataBase / OG / sitemap / robots — из одного источника,
 * чтобы ссылки в метатегах никогда не разъезжались.
 */
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '') ||
  'https://tg-swipe.vercel.app'

export const SITE_NAME = 'Tg Swipe'
