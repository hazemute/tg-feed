import { db } from '@/lib/db'
import type { Comment, User } from '@prisma/client'
import type { CommentDTO } from '@/lib/types'
import { parseBadges } from '@/lib/badges'
import { emitAppEvent } from '@/lib/events'
import { sendBotNotification } from '@/lib/bot-notify'
import { userAvatarProxyUrl } from '@/lib/media'

/**
 * Серверные помощники комментариев (общие для /api/comments, /api/comments/[id],
 * /api/comments/[id]/like): маппинг DTO, лайки «likedByMe», уведомления.
 *
 * Дерево «как в TikTok»: один уровень вложенности — parentId только на корень,
 * replyToName — плашка «Ответ NAME» внутри ветки.
 */

/**
 * v5.69: прочный прокси-URL аватарки (единая логика с lib/media.ts).
 * Раньше сырой photoUrl (cdn*.telesco.pe из initData, живёт ~час) уезжал
 * на фронт как есть — аватарки в комментариях «слетали».
 */
export function avatarUrlOf(userId: string, photoUrl: string | null): string | null {
  return userAvatarProxyUrl(userId, photoUrl)
}

type AuthorUser = Pick<User, 'id' | 'username' | 'firstName' | 'lastName' | 'photoUrl' | 'badges'>

/** Публичное представление автора комментария (без приватных полей) */
export function authorOf(u: AuthorUser) {
  const name =
    [u.firstName, u.lastName].filter(Boolean).join(' ').trim() ||
    (u.username ? `@${u.username}` : 'Читатель')
  return {
    id: u.id,
    name,
    username: u.username,
    avatarUrl: avatarUrlOf(u.id, u.photoUrl),
    badges: parseBadges(u.badges),
  }
}

type CommentWithUser = Comment & { user: AuthorUser }

/** Маппинг строки БД → CommentDTO (likedByMe — по множеству лайков сессии) */
export function toCommentDTO(
  c: CommentWithUser,
  uid: string | null,
  likedSet: Set<string>,
  replies?: CommentDTO[],
): CommentDTO {
  return {
    id: c.id,
    postId: c.postId,
    text: c.text,
    createdAt: c.createdAt.toISOString(),
    author: authorOf(c.user),
    own: uid !== null && c.userId === uid,
    parentId: c.parentId,
    replyToName: c.replyToName,
    likesCount: c.likesCount,
    likedByMe: likedSet.has(c.id),
    repliesCount: c.repliesCount,
    // v5.68: флаг скрытия (антиреклама/жалобы) — автор видит свой с плашкой
    ...(c.hidden ? { hidden: true, adScore: c.adScore } : {}),
    ...(replies ? { replies } : {}),
  }
}

/** Множество id комментариев, залайканных текущим пользователем из выборки */
export async function likedSetFor(uid: string | null, ids: string[]): Promise<Set<string>> {
  if (!uid || ids.length === 0) return new Set()
  const rows = await db.commentLike.findMany({
    where: { userId: uid, commentId: { in: ids } },
    select: { commentId: true },
  })
  return new Set(rows.map((r) => r.commentId))
}

/**
 * Уведомление-активность (fire-and-forget): ответ на комментарий, лайк
 * комментария, новый комментарий под постом привязанного канала.
 * commentId — глубокая ссылка: тап по уведомлению открывает комментарии
 * на этом комментарии (ветка раскрывается, экран скроллится к нему).
 * Ошибки логируются и не влияют на ответ API.
 */
export function notifyUser(data: {
  userId: string
  type: 'comment' | 'reply' | 'comment_like'
  title: string
  body: string
  postId?: string | null
  commentId?: string | null
  channelUsername?: string | null
}): void {
  void (async () => {
    try {
      await db.notification.create({
        data: {
          userId: data.userId,
          type: data.type,
          title: data.title,
          body: data.body.slice(0, 200),
          postId: data.postId ?? null,
          commentId: data.commentId ?? null,
          channelUsername: data.channelUsername ?? null,
        },
      })
      // Мгновенный толчок бейджу колокольчика: SSE-клиенты пользователя
      // обновят счётчик без 30-секундного поллинга
      emitAppEvent('notif:new', { userId: data.userId })
      // v5.45: ДОПОЛНИТЕЛЬНО бот пишет в ЛС — ссылка на приложение в тексте
      // + инлайн-кнопка «Перейти к уведомлению» (startapp deep-link в миниапп)
      sendBotNotification({
        userId: data.userId,
        type: data.type,
        title: data.title,
        body: data.body,
        postId: data.postId,
        commentId: data.commentId,
      })
    } catch (e) {
      console.error('[comments notify]', e)
    }
  })()
}
