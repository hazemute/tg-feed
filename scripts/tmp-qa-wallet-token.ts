/**
 * QA: тестовый юзер с балансом + JWT для браузерных проверок кошелька.
 * Запуск: bun scripts/tmp-qa-wallet-token.ts
 */
import crypto from 'crypto'
import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()
let uid: string = 'qa_wallet_tester'

try {
  const existing = await p.user.findUnique({ where: { id: uid } })
  if (existing) {
    await p.user.update({ where: { id: uid }, data: { swipes: 25_000, balanceKop: 150_000 } })
  } else {
    const any = await p.user.findFirst({ select: { id: true }, orderBy: { id: 'asc' } })
    if (!any) throw new Error('no users in db')
    uid = any.id
    await p.user.update({ where: { id: uid }, data: { swipes: 25_000, balanceKop: 150_000 } })
  }
  const env = await Bun.file('.env').text()
  const m = env.match(/AUTH_SECRET=(\S+)/)
  if (!m) throw new Error('AUTH_SECRET not found')
  const SECRET = m[1]
  const b64url = (s: string | Buffer) =>
    Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const now = Math.floor(Date.now() / 1000)
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const pl = b64url(JSON.stringify({ uid, guest: true, iat: now, exp: now + 86_400 * 7 }))
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(`${h}.${pl}`).digest())
  console.log('TOKEN=' + `${h}.${pl}.${sig}`)
} catch (e) {
  console.error('ERR:', e instanceof Error ? e.message.slice(0, 400) : String(e).slice(0, 400))
} finally {
  await p.$disconnect()
}
