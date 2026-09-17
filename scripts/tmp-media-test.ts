import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const p = await db.post.findFirst({ where: { mediaUrl: { contains: 'telesco.pe' }, mediaType: 'image' }, orderBy: { publishedAt: 'desc' }, select: { mediaUrl: true } })
  if (!p?.mediaUrl) { console.log('none'); return }
  console.log('URL:', p.mediaUrl)
  for (const [label, headers] of [['plain', {}], ['referer', { Referer: 'https://t.me/', 'User-Agent': 'Mozilla/5.0' }]] as const) {
    try {
      const r = await fetch(p.mediaUrl, { headers, signal: AbortSignal.timeout(12000) })
      const buf = await r.arrayBuffer()
      console.log(label, '→', r.status, 'ct:', r.headers.get('content-type'), 'len:', buf.byteLength)
    } catch (e) { console.log(label, '→ ERR', String(e).slice(0, 120)) }
  }
}
main().finally(() => db.$disconnect())
