/** Разовая диагностика: гости и эскроу-балансы в Supabase */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  const guests = await db.user.count({ where: { id: { startsWith: 'guest_' } } })
  const tgUsers = await db.user.count({ where: { id: { startsWith: 'tg_' } } })
  console.log('guests:', guests, 'tg:', tgUsers)

  const accs = await db.advertiserAccount.findMany({
    select: { userId: true, balanceKop: true, topupsTotalKop: true },
  })
  console.log('advertiser accounts:', JSON.stringify(accs, null, 1))

  const sampleGuests = await db.user.findMany({
    where: { id: { startsWith: 'guest_' } },
    select: { id: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 10,
  })
  console.log('recent guests:', JSON.stringify(sampleGuests, null, 1))

  const ads = await db.adCampaign.findMany({ select: { id: true, status: true, userId: true } })
  console.log('campaigns:', JSON.stringify(ads, null, 1))

  const payments = await db.pendingPayment.findMany({
    select: { id: true, status: true, amountKop: true, purpose: true },
    take: 20,
  })
  console.log('payments:', JSON.stringify(payments, null, 1))
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
