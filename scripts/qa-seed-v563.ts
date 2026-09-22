/**
 * Локальный сид для QA v5.58: тестовый пользователь (100 000 свайпов — проверка
 * полноформатного числа), привязанный канал, посты. Токен → /tmp/token.txt.
 * Запуск: bun scripts/qa-seed-v563.ts
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import crypto from 'node:crypto'
import { writeFileSync } from 'node:fs'

const db = new PrismaClient()
const TEST_TG_ID = 777000
const TEST_USER = 'tg_777000'

async function main() {
  // Категории уже есть из prisma/seed.ts; возьмём первую
  const cat = await db.category.findFirst()
  if (!cat) throw new Error('Сначала запусти prisma/seed.ts (категории)')

  const user = await db.user.upsert({
    where: { id: TEST_USER },
    update: { swipes: 100_000, balanceKop: 2500, tier: 'pro', isGuest: false },
    create: {
      id: TEST_USER,
      username: 'qa_tester',
      firstName: 'QA',
      lastName: 'Tester',
      isGuest: false,
      categories: JSON.stringify([cat.slug]),
      swipes: 100_000,
      balanceKop: 2500,
      tier: 'pro',
    },
  })

  const ch = await db.channel.upsert({
    where: { username: 'qa_channel' },
    update: { claimedById: user.id },
    create: {
      tgId: '-100999000111',
      username: 'qa_channel',
      title: 'QA Канал',
      description: 'Тестовый канал для проверки вкладки «Канал»',
      categoryId: cat.id,
      claimedById: user.id,
      subscribersCount: 1234,
      avatarColor: '#f5a623',
      status: 'active',
      teaserMode: 'cut',
      teaserLimit: 160,
    },
  })

  const posts = await db.post.findMany({ where: { channelId: ch.id }, take: 1 })
  if (posts.length === 0) {
    for (let i = 1; i <= 12; i++) {
      await db.post.create({
        data: {
          tgKey: `qa_channel:${1000 + i}`,
          channelId: ch.id,
          text:
            `**Пост №${i}** — проверка ленты и ассистента.\n\n` +
            'Текст поста для превью, достаточно длинный, чтобы обрезка тизера работала: '.repeat(2),
          mediaType: 'none',
          publishedAt: new Date(Date.now() - i * 3600_000),
          viewsCount: 100 * i,
        },
      })
    }
  }

  // JWT как в scripts/test-quests.ts; v5.78: секрет должен совпадать с
  // session.ts: AUTH_SECRET берётся КАК ЕСТЬ, без AUTH_SECRET — фолбэк
  // sha256('tgfeed-session|') (песочница/dev)
  const secret = process.env.AUTH_SECRET?.trim() || crypto.createHash('sha256').update('tgfeed-session|').digest('hex')
  const b64url = (i: string) => Buffer.from(i).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const nowS = Math.floor(Date.now() / 1000)
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const pld = b64url(JSON.stringify({ uid: user.id, guest: false, iat: nowS, exp: nowS + 86400 }))
  const token = `${h}.${pld}.${b64url(crypto.createHmac('sha256', secret).update(`${h}.${pld}`).digest())}`
  writeFileSync('/tmp/token.txt', token)
  console.log('OK: user', user.id, '| channel', ch.id, '| token → /tmp/token.txt')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
