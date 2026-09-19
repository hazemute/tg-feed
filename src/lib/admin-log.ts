import { db } from '@/lib/db'

/**
 * Аудит действий администратора (v5.18): каждая операция панели, меняющая
 * состояние пользователя/контента, оставляет строку в AdminLog. По журналу
 * работает вкладка «Журнал» — видно, кто когда выдал подписку, забанил,
 * поменял баланс. Лог никогда не бросает: сбой записи не должен ломать
 * саму операцию.
 */
export async function logAdmin(
  action: string,
  target: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.adminLog.create({
      data: {
        action: action.slice(0, 64),
        target: target.slice(0, 120),
        meta: meta ? JSON.stringify(meta).slice(0, 2000) : null,
      },
    })
  } catch (e) {
    console.error('[admin-log] write failed', (e as Error).message)
  }
}

/** Человекочитаемые названия действий для вкладки «Журнал» */
export const ADMIN_ACTION_LABELS: Record<string, string> = {
  tier_grant: 'Выдана подписка',
  tier_extend: 'Продлена подписка',
  tier_revoke: 'Отозвана подписка',
  badge_grant: 'Выдан бейдж',
  badge_revoke: 'Снят бейдж',
  premium_on: 'Включён Premium',
  premium_off: 'Выключен Premium',
  swipes: 'Изменён баланс свайпов',
  ban: 'Бан пользователя',
  unban: 'Разбан пользователя',
  bypass_on: 'Допуск мимо техработ',
  bypass_off: 'Отозван допуск мимо техработ',
  ops: 'Быстрая операция',
  purge_demo: 'Стерилизация демо-данных',
  moderation: 'Модерация канала',
  campaign: 'Модерация кампании',
  comment: 'Действие с комментарием',
}
