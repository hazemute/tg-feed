import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/lib/site'

/**
 * robots (v5.57): сервис индексируем, служебное — нет.
 * Админ-панель и API не должны появляться в поиске.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/admin', '/api/'],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}
