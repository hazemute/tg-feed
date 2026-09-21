/**
 * Генератор PWA-иконок из public/logo.svg (v5.57).
 * Разовый скрипт: bun scripts/gen-icons.ts
 */
import sharp from 'sharp'
import { join } from 'path'

const ROOT = join(import.meta.dir, '..')
const SVG = join(ROOT, 'public', 'logo.svg')

async function make(size: number, out: string, opts: { bg?: string; pad?: number } = {}) {
  const pad = opts.pad ?? 0.72
  const glyph = await sharp(SVG, { density: 512 })
    .resize(Math.round(size * pad), Math.round(size * pad), { fit: 'inside' })
    .png()
    .toBuffer()
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: opts.bg ?? { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([{ input: glyph, gravity: 'centre' }])
    .png()
    .toFile(join(ROOT, 'public', out))
  console.log('OK', out, size)
}

await make(512, 'icon-512.png')
await make(192, 'icon-192.png')
await make(180, 'apple-touch-icon.png')
await make(32, 'favicon-32.png', { pad: 0.9 })
console.log('done')
