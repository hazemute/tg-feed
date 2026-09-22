/**
 * QA: тестовый юзер (не гость, обход техработ) + JWT для браузерных проверок.
 * Запуск: bun scripts/tmp-qa-token-583.ts
 */
import crypto from 'crypto'
import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()
const uid = 'qa_wallet_tester'

try {
  const existing = await p.user.findUnique({ where: { id: uid } })
  const data = {
    isGuest: false,
    bypassMaintenance: true,
    swipes: 25_000,
    balanceKop: 150_000,
    tier: 'pro' as const,
    tierUntil: new Date(Date.now() + 86_400_000 * 30),
  }
  if (existing) {
    await p.user.update({ where: { id: uid }, data })
  } else {
    await p.user.create({
      data: { id: uid, username: 'qa_wallet_tester', firstName: 'QA Wallet', ...data },
    })
  }
  const env = await Bun.file('.env').text()
  const m = env.match(/AUTH_SECRET=(\S+)/)
  if (!m) throw new Error('AUTH_SECRET not found')
  const SECRET = m[1]
  const b64url = (s: string | Buffer) =>
    Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const now = Math.floor(Date.now() / 1000)
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const pl = b64url(JSON.stringify({ uid, guest: false, iat: now, exp: now + 86_400 * 7 }))
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(`${h}.${pl}`).digest())
  console.log('TOKEN=' + `${h}.${pl}.${sig}`)
} catch (e) {
  console.error('ERR:', e instanceof Error ? e.message.slice(0, 400) : String(e).slice(0, 400))
} finally {
  await p.$disconnect()
}
