import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/lib/site'

/**
 * Карта сайта (v5.57): публичные страницы сервиса.
 * Динамический контент (каналы/посты) отдаётся через API миниаппа —
 * в sitemap попадают стабильные документы.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date()
  return [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: 'hourly', priority: 1 },
    { url: `${SITE_URL}/pricing`, lastModified: now, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${SITE_URL}/terms`, lastModified: now, changeFrequency: 'yearly', priority: 0.4 },
    { url: `${SITE_URL}/privacy`, lastModified: now, changeFrequency: 'yearly', priority: 0.4 },
    { url: `${SITE_URL}/contacts`, lastModified: now, changeFrequency: 'yearly', priority: 0.4 },
  ]
}
