/** QA: гостевой аккаунт + токен. Удалить перед коммитом. */
import crypto from 'crypto'
import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
try {
  await p.user.upsert({ where: { id: 'guest_qa' }, update: { bypassMaintenance: true }, create: { id: 'guest_qa', isGuest: true, firstName: 'Guest QA', bypassMaintenance: true } })
  const env = await Bun.file('.env').text()
  const SECRET = env.match(/AUTH_SECRET=(\S+)/)![1]
  const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const now = Math.floor(Date.now() / 1000)
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const pl = b64url(JSON.stringify({ uid: 'guest_qa', guest: true, iat: now, exp: now + 86400 }))
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(`${h}.${pl}`).digest())
  console.log('TOKEN=' + `${h}.${pl}.${sig}`)
} finally { await p.$disconnect() }
