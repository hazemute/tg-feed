import { db } from '@/lib/db'

/**
 * Стерилизация демо-данных (приказ владельца): проект боевой — гостей и
 * фейковых балансов быть не должно.
 *
 *  1. Удаляет ВСЕХ гостей (id начинается с "guest_") со всеми их данными:
 *     лайки/просмотры/подписки/закладки/муты, комментарии и их лайки, чаты
 *     поддержки и предложки, уведомления, загрузки, кампании, эскроу,
 *     ИИ-поиски, платежи, клики хэштегов, журнал переводов.
 *  2. Удаляет эскроу-балансы, которые НИКОГДА не пополнялись
 *     (topupsTotalKop = 0) — это следы демо-сидов вида «у всех по 500 ₽».
 *     Балансы с реальными пополнениями (Stars/карта/TON) не трогаются.
 *
 * Идемпотентно: после чистки повторные прогоны удаляют 0 строк — безопасно
 * вызывать при каждом старте сервера и из панели («Инструменты»).
 */

const GUEST_ID = { startsWith: 'guest_' }

export type PurgeResult = {
  guests: number // удалено гостевых аккаунтов
  fakeEscrow: number // удалено «пустых» эскроу-балансов (демо-деньги)
  details: Record<string, number> // удалено строк по таблицам
}

type PurgeStep = { name: string; run: () => Promise<{ count: number }> }

function purgeSteps(): PurgeStep[] {
  return [
    { name: 'supportMessage', run: () => db.supportMessage.deleteMany({ where: { thread: { userId: GUEST_ID } } }) },
    { name: 'supportThread', run: () => db.supportThread.deleteMany({ where: { userId: GUEST_ID } }) },
    { name: 'commentLike', run: () => db.commentLike.deleteMany({ where: { userId: GUEST_ID } }) },
    { name: 'comment', run: () => db.comment.deleteMany({ where: { userId: GUEST_ID } }) },
    { name: 'like', run: () => db.like.deleteMany({ where: { userId: GUEST_ID } }) },
    { name: 'postView', run: () => db.postView.deleteMany({ where: { userId: GUEST_ID } }) },
    { name: 'subscription', run: () => db.subscription.deleteMany({ where: { userId: GUEST_ID } }) },
    { name: 'channelMute', run: () => db.channelMute.deleteMany({ where: { userId: GUEST_ID } }) },
    { name: 'bookmark', run: () => db.bookmark.deleteMany({ where: { userId: GUEST_ID } }) },
    { name: 'notification', run: () => db.notification.deleteMany({ where: { userId: GUEST_ID } }) },
    { name: 'upload', run: () => db.upload.deleteMany({ where: { ownerId: GUEST_ID } }) },
    { name: 'adCampaign', run: () => db.adCampaign.deleteMany({ where: { ownerId: GUEST_ID } }) },
    { name: 'advertiserAccount', run: () => db.advertiserAccount.deleteMany({ where: { userId: GUEST_ID } }) },
    { name: 'aiSearchLog', run: () => db.aiSearchLog.deleteMany({ where: { userId: GUEST_ID } }) },
    { name: 'pendingPayment', run: () => db.pendingPayment.deleteMany({ where: { userId: GUEST_ID } }) },
    { name: 'hashtagClick', run: () => db.hashtagClick.deleteMany({ where: { userId: GUEST_ID } }) },
    { name: 'campaignClick', run: () => db.campaignClick.deleteMany({ where: { userId: GUEST_ID } }) },
    { name: 'translationLog', run: () => db.translationLog.deleteMany({ where: { userId: GUEST_ID } }) },
    { name: 'user', run: () => db.user.deleteMany({ where: { id: GUEST_ID } }) },
  ]
}

export async function purgeDemoData(): Promise<PurgeResult> {
  const details: Record<string, number> = {}

  // --- 1. Данные гостей (дети — до удаления самих пользователей) ---
  for (const step of purgeSteps()) {
    const r = await step.run()
    if (r.count > 0) details[step.name] = r.count
  }

  // --- 2. Эскроу-балансы без единого пополнения (демо-деньги «на ровном месте») ---
  const fake = await db.advertiserAccount.deleteMany({ where: { topupsTotalKop: { lte: 0 } } })
  if (fake.count > 0) details.advertiserAccountFake = fake.count

  return { guests: details.user ?? 0, fakeEscrow: fake.count, details }
}

/** Быстрая сводка для панели: что сейчас подлежит стерилизации (без удаления). */
export async function demoDataStats(): Promise<{
  guests: number
  fakeEscrow: number
  fakeEscrowKop: number
}> {
  const [guests, accs] = await Promise.all([
    db.user.count({ where: { id: GUEST_ID } }),
    db.advertiserAccount.findMany({
      where: { topupsTotalKop: { lte: 0 } },
      select: { balanceKop: true },
    }),
  ])
  return {
    guests,
    fakeEscrow: accs.length,
    fakeEscrowKop: accs.reduce((s, a) => s + a.balanceKop, 0),
  }
}
