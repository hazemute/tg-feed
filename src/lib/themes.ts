import type { ThemeMode } from '@/lib/types'

/**
 * Каталог тем оформления: синхронизация с Telegram,
 * светлые и тёмные палитры. Цвета карточек-превью повторяют токены
 * из globals.css ([data-theme='...']).
 */

export type ThemeGroup = 'sync' | 'light' | 'dark'

export type ThemeMeta = {
  id: ThemeMode
  name: string
  group: ThemeGroup
  /** Цвета превью-карточки в галерее */
  preview: { bg: string; surface: string; text: string; accent: string }
}

export const THEMES: ThemeMeta[] = [
  {
    id: 'auto',
    name: 'Как в Telegram',
    group: 'sync',
    preview: { bg: '#f2f2f7', surface: '#e8e8ed', text: '#0a0a0a', accent: '#0a84ff' },
  },
  // ------- Светлые -------
  {
    id: 'light',
    name: 'Светлая',
    group: 'light',
    preview: { bg: '#ffffff', surface: '#f2f2f7', text: '#0a0a0a', accent: '#0a84ff' },
  },
  {
    id: 'sepia',
    name: 'Сепия',
    group: 'light',
    preview: { bg: '#f7f1e4', surface: '#efe6d2', text: '#3a2e21', accent: '#a8732f' },
  },
  {
    id: 'sand',
    name: 'Песок',
    group: 'light',
    preview: { bg: '#faf6ee', surface: '#f0e9da', text: '#4a4234', accent: '#c08a3e' },
  },
  {
    id: 'rose',
    name: 'Роза',
    group: 'light',
    preview: { bg: '#fdf2f4', surface: '#f7e3e8', text: '#3d2229', accent: '#d4547a' },
  },
  {
    id: 'mint',
    name: 'Мята',
    group: 'light',
    preview: { bg: '#effaf3', surface: '#ddefe3', text: '#1e3a2a', accent: '#2e9e63' },
  },
  {
    id: 'lavender',
    name: 'Лаванда',
    group: 'light',
    preview: { bg: '#f6f2fc', surface: '#eae2f7', text: '#2c2440', accent: '#8b5cf6' },
  },
  {
    id: 'pearl',
    name: 'Жемчуг',
    group: 'light',
    preview: { bg: '#f5f8f8', surface: '#e9f0f0', text: '#1f2a2a', accent: '#2a9d8f' },
  },
  {
    id: 'lime',
    name: 'Лайм',
    group: 'light',
    preview: { bg: '#f5faec', surface: '#e9f2d8', text: '#24301a', accent: '#5f9e2f' },
  },
  {
    id: 'honey',
    name: 'Медовый',
    group: 'light',
    preview: { bg: '#fbf5e6', surface: '#f4ead0', text: '#33280f', accent: '#c58a1d' },
  },
  {
    id: 'coral',
    name: 'Коралл',
    group: 'light',
    preview: { bg: '#fdf4f0', surface: '#f9e5dc', text: '#3a2018', accent: '#e05d3d' },
  },
  // ------- Тёмные -------
  {
    id: 'dark',
    name: 'Тёмная',
    group: 'dark',
    preview: { bg: '#0e141c', surface: '#17202c', text: '#eef3f8', accent: '#62bcf9' },
  },
  {
    id: 'mono',
    name: 'Моно',
    group: 'dark',
    preview: { bg: '#101010', surface: '#1c1c1c', text: '#f2f2f2', accent: '#d4d4d4' },
  },
  {
    id: 'forest',
    name: 'Лес',
    group: 'dark',
    preview: { bg: '#0f1a12', surface: '#17251a', text: '#e6f0e8', accent: '#58b368' },
  },
  {
    id: 'ocean',
    name: 'Океан',
    group: 'dark',
    preview: { bg: '#0b1a20', surface: '#13242c', text: '#e3f0f4', accent: '#3ab5ae' },
  },
  {
    id: 'midnight',
    name: 'Полночь',
    group: 'dark',
    preview: { bg: '#0d1017', surface: '#161a28', text: '#e8eaf2', accent: '#7d8cff' },
  },
  {
    id: 'plum',
    name: 'Слива',
    group: 'dark',
    preview: { bg: '#170f1a', surface: '#231828', text: '#f2e8f4', accent: '#c26bd9' },
  },
  {
    id: 'coffee',
    name: 'Кофе',
    group: 'dark',
    preview: { bg: '#17110d', surface: '#251b14', text: '#f2eae2', accent: '#c98f5f' },
  },
  {
    id: 'sunset',
    name: 'Закат',
    group: 'dark',
    preview: { bg: '#1a0f0d', surface: '#271715', text: '#f6e8e4', accent: '#f2764a' },
  },
  {
    id: 'emerald',
    name: 'Изумруд',
    group: 'dark',
    preview: { bg: '#0a1410', surface: '#12211a', text: '#e4f2ea', accent: '#38c98c' },
  },
  {
    id: 'crimson',
    name: 'Багряный',
    group: 'dark',
    preview: { bg: '#190c0f', surface: '#241317', text: '#f4e8ea', accent: '#ef5a6f' },
  },
  {
    id: 'aurora',
    name: 'Аврора',
    group: 'dark',
    preview: { bg: '#0a1618', surface: '#122225', text: '#e2f2f1', accent: '#45d0b4' },
  },
  {
    id: 'cherry',
    name: 'Вишня',
    group: 'dark',
    preview: { bg: '#170d12', surface: '#231419', text: '#f4e9ef', accent: '#e6699c' },
  },
]

export const THEME_BY_ID = new Map(THEMES.map((t) => [t.id, t]))

/** Тёмная ли это палитра (для синхрона класса .dark на <html>, v5.27.1) */
export function isDarkPalette(id: ThemeMode): boolean {
  return THEME_BY_ID.get(id)?.group === 'dark'
}

export function themeName(id: ThemeMode): string {
  if (id === 'custom') return 'Своя палитра'
  return THEME_BY_ID.get(id)?.name ?? 'Светлая'
}
