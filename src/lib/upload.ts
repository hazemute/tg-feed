'use client'

/**
 * Сжатие картинок перед загрузкой (приказ владельца: «сжимались до килобит
 * без потери качества по возможности»): canvas → WebP (fallback JPEG),
 * длинная сторона ≤1280px, качество 0.72 — типичный скрин 2-3МБ → 40-90КБ,
 * качество текста на скриншотах остаётся читаемым. Результат — dataURL,
 * готовый к POST /api/upload.
 */

export type CompressedImage = {
  dataUrl: string
  width: number
  height: number
  bytes: number
  mime: 'image/webp' | 'image/jpeg'
}

export async function compressImage(file: File, maxDim = 1280, quality = 0.72): Promise<CompressedImage> {
  if (!file.type.startsWith('image/')) throw new Error('not an image')

  const bitmap = await createImageBitmap(file).catch(async () => {
    // Safari без createImageBitmap для некоторых форматов — через <img>
    const url = URL.createObjectURL(file)
    try {
      const img = new Image()
      img.src = url
      await img.decode()
      return img as unknown as ImageBitmap
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    }
  })
  const w = 'width' in bitmap ? bitmap.width : 0
  const h = 'height' in bitmap ? bitmap.height : 0
  if (!w || !h) throw new Error('cannot decode image')

  const scale = Math.min(1, maxDim / Math.max(w, h))
  const cw = Math.max(1, Math.round(w * scale))
  const ch = Math.max(1, Math.round(h * scale))

  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no canvas ctx')
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0, cw, ch)

  // WebP сначала (в 2-4 раза меньше JPEG), Safari 14+ умеет кодировать
  let dataUrl = canvas.toDataURL('image/webp', quality)
  let mime: 'image/webp' | 'image/jpeg' = 'image/webp'
  if (!dataUrl.startsWith('data:image/webp')) {
    dataUrl = canvas.toDataURL('image/jpeg', quality)
    mime = 'image/jpeg'
  }
  // Если вдруг вышло больше лимита сервера — снижаем качество и сторону
  let bytes = Math.floor((dataUrl.length * 3) / 4)
  let q = quality
  let dim = maxDim
  while (bytes > 340_000 && q > 0.35) {
    q -= 0.12
    dataUrl = mime === 'image/webp' ? canvas.toDataURL('image/webp', q) : canvas.toDataURL('image/jpeg', q)
    if (!dataUrl.startsWith(mime === 'image/webp' ? 'data:image/webp' : 'data:image/jpeg')) {
      mime = 'image/jpeg'
      dataUrl = canvas.toDataURL('image/jpeg', q)
    }
    bytes = Math.floor((dataUrl.length * 3) / 4)
  }
  if (bytes > 340_000) {
    dim = Math.round(maxDim * 0.7)
    const cw2 = Math.max(1, Math.round((w * dim) / Math.max(w, h)))
    const ch2 = Math.max(1, Math.round((h * dim) / Math.max(w, h)))
    canvas.width = cw2
    canvas.height = ch2
    ctx.drawImage(bitmap as CanvasImageSource, 0, 0, cw2, ch2)
    dataUrl = canvas.toDataURL('image/jpeg', 0.55)
    mime = 'image/jpeg'
    bytes = Math.floor((dataUrl.length * 3) / 4)
  }

  return { dataUrl, width: cw, height: ch, bytes, mime }
}

/** Загрузка сжатой картинки на сервер → url /api/upload/{id} */
export async function uploadImage(file: File): Promise<string> {
  const { api } = await import('@/lib/api')
  const img = await compressImage(file)
  const res = await api<{ url: string }>('/api/upload', {
    method: 'POST',
    body: JSON.stringify({ data: img.dataUrl, width: img.width, height: img.height }),
  })
  return res.url
}
