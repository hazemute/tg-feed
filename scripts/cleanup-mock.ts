/**
 * ВЫЧИСТКА МОК-ДАННЫХ из общей БД (Supabase):
 *  - удаляет все синтетические сид-каналы (вместе с их мок-постами, лайками,
 *    просмотрами, закладками и подписками — каскад по схеме);
 *  - удаляет мок-рекламу (title'ы из сида);
 *  - удаляет одноразовых curl-тестовых пользователей.
 * Реальные каналы (например warstatechannel) и живые пользователи не трогаются.
 *
 * Запуск: set -a && source .env && set +a && bun run scripts/cleanup-mock.ts
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

/** Username'ы каналов, созданных prisma/seed.ts (синтетика) */
const MOCK_CHANNEL_USERNAMES = [
  'cryptokot_feed',
  'coinvoice_feed',
  'defiradar_feed',
  'srochnye_feed',
  'newslight_feed',
  'techtalk_feed',
  'devdigest_feed',
  'aiwave_feed',
  'sarcasm_room', // username реальный, но контент в БД от сида — пересоберётся автосбором
  'devhumor_feed',
  'bizstart_feed',
  'moneymind_feed',
  'cheaptrip_feed',
  'roadnotes_feed',
  'cookfast_feed',
  'coffeetime_feed',
  'sportpulse_feed',
  'football_review',
]

/** Мок-реклама из сида (если когда-то заливалась) */
const MOCK_AD_TITLES = [
  'Крипто-сигналы PRO',
  'VPN для Telegram',
  'Ваша реклама в TG-Feed',
]

async function main() {
  const before = {
    channels: await db.channel.count(),
    posts: await db.post.count(),
    ads: await db.ad.count(),
  }

  const deletedChannels = await db.channel.deleteMany({
    where: { username: { in: MOCK_CHANNEL_USERNAMES } },
  })
  const deletedAds = await db.ad.deleteMany({ where: { title: { in: MOCK_AD_TITLES } } })
  const deletedUsers = await db.user.deleteMany({ where: { id: { startsWith: 'demo_curltest' } } })

  const after = {
    channels: await db.channel.count(),
    posts: await db.post.count(),
    ads: await db.ad.count(),
  }

  console.log('BEFORE:', before)
  console.log(`Deleted: channels=${deletedChannels.count}, ads=${deletedAds.count}, testUsers=${deletedUsers.count}`)
  console.log('AFTER:  ', after)
  console.log('Остались только реальные каналы и живые пользователи.')

  await db.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
