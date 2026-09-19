import { db } from '@/lib/db'

/**
 * Гость стал verified-пользователем: переносим его данные из гостевой строки
 * (лайки/закладки/просмотры/подписки/интересы/граница уведомлений), чтобы
 * история, накопленная до подтверждения, не потерялась.
 *
 * opts.deleteSource — удалять ли гостевую строку после переноса.
 *  • true  (Mini App, /api/auth) — гостевая строка больше не нужна;
 *  • false (вход через бота на сайте) — строку СОХРАНЯЕМ: старый гостевой
 *    JWT остаётся валидным, ни один in-flight запрос не словит 401 и не
 *    перезапишет свежую tg-сессию re-auth'ом.
 *
 * Ошибка миграции НЕ ломает вход (try/catch снаружи).
 */
export async function migrateGuestUserData(
  guestId: string,
  targetId: string,
  opts: { deleteSource?: boolean } = {},
): Promise<void> {
  const deleteSource = opts.deleteSource !== false
  try {
    const guest = await db.user.findUnique({ where: { id: guestId } })
    if (!guest || guest.id === targetId) return

    await db.$transaction(async (tx) => {
      const [subs, likes, bookmarks, views] = await Promise.all([
        tx.subscription.findMany({ where: { userId: guestId } }),
        tx.like.findMany({ where: { userId: guestId } }),
        tx.bookmark.findMany({ where: { userId: guestId } }),
        tx.postView.findMany({ where: { userId: guestId } }),
      ])

      if (subs.length > 0) {
        await tx.subscription.createMany({
          data: subs.map((s) => ({
            userId: targetId,
            channelId: s.channelId,
            hidden: s.hidden,
            notify: s.notify,
            createdAt: s.createdAt,
          })),
          skipDuplicates: true as never,
        })
        await tx.subscription.deleteMany({ where: { userId: guestId } })
      }
      if (likes.length > 0) {
        await tx.like.createMany({
          data: likes.map((l) => ({ userId: targetId, postId: l.postId, createdAt: l.createdAt })),
          skipDuplicates: true as never,
        })
        await tx.like.deleteMany({ where: { userId: guestId } })
      }
      if (bookmarks.length > 0) {
        await tx.bookmark.createMany({
          data: bookmarks.map((b) => ({
            userId: targetId,
            postId: b.postId,
            createdAt: b.createdAt,
            readAt: b.readAt,
          })),
          skipDuplicates: true as never,
        })
        await tx.bookmark.deleteMany({ where: { userId: guestId } })
      }
      if (views.length > 0) {
        await tx.postView.createMany({
          data: views.map((v) => ({ userId: targetId, postId: v.postId, createdAt: v.createdAt })),
          skipDuplicates: true as never,
        })
        await tx.postView.deleteMany({ where: { userId: guestId } })
      }

      await tx.user.update({
        where: { id: targetId },
        data: {
          ...(guest.categories !== '[]' && { categories: guest.categories }),
          ...(guest.lastSeenNotifiedAt && { lastSeenNotifiedAt: guest.lastSeenNotifiedAt }),
        },
      })

      if (deleteSource) await tx.user.delete({ where: { id: guestId } })
    })
  } catch (e) {
    console.error('[auth] guest migration failed (non-fatal)', e)
  }
}
