import { db } from '@/lib/db'
import { logAdmin } from '@/lib/admin-log'

/**
 * v6.7.0: АВТО-ВЫДАЧА ПРИЗОВ КОНКУРСА (100 мест) при входе в миниапп.
 *
 * Контекст: конкурс был канальным — 79 из 100 победителей не имели аккаунта
 * в приложении на момент выдачи призов. Ручной скрипт .qa/grant-contest.ts
 * выдал призы только тем 9, кто уже был в базе. Пока приз ждал РУЧНОГО
 * перезапуска скрипта, победитель мог зайти в миниапп и не получить ничего.
 * Теперь при КАЖДОМ входе (POST /api/auth, fire-and-forget) проверяем по
 * username: не победитель ли это — и выдаём приз один раз.
 *
 * Идемпотентность: маркер BotSetting `contest:done:<userId>` создаётся
 * АТОМАРНО ДО выдачи (create-lock, как dm-маркеры в bot-notify.ts) —
 * параллельные инстансы не задвоят приз (проигравший гонку ловит P2002
 * и молча выходит). Если сама выдача после маркера упала — приз можно
 * выдать вручную, удалив маркер.
 *
 * Диапазоны (таблица владельца):
 *   1-5    → Telegram Premium / звёзды — НЕ наш сервис, пропускаем;
 *   6-13   → Snap Pro 5 дней;
 *   14-18  → Snap Plus 5 дней;
 *   19-28  → приватка AutoBuy — НЕ наш сервис, пропускаем;
 *   29-100 → общий пул 500 000 свайпов на 72 места → floor = 6944 каждому.
 *
 * Даунгрейд исключён: если у победителя активен Pro, а приз Plus —
 * продлеваем Pro на те же 5 дней (не понижаем тир).
 */

const DAY_MS = 86_400_000
const PRO_DAYS = 5
const PLUS_DAYS = 5
const SWIPES_EACH = 6944

type Winner = { place: number; handle: string }

/** Только наши диапазоны призов (6-18 тир, 29-100 свайпы). Места 1-5 и 19-28
 *  — призы вне сервиса, хэндлы 28/79 — «ник-невидимка», их тут нет. */
const WINNERS: Winner[] = [
  { place: 6, handle: 'Domalmaznu33' },
  { place: 7, handle: 'A_YU0770' },
  { place: 8, handle: 'qnloes' },
  { place: 9, handle: 'luckyman1331' },
  { place: 10, handle: 'chilo_viyparenok' },
  { place: 11, handle: 'Semechka_808' },
  { place: 12, handle: 'Olga_krassa' },
  { place: 13, handle: 'ixoho' },
  { place: 14, handle: 'superman_076' },
  { place: 15, handle: 'Tsabaev96' },
  { place: 16, handle: 'ammchs' },
  { place: 17, handle: 'kabldla' },
  { place: 18, handle: 'pavkarpat' },
  { place: 29, handle: 'wedula' },
  { place: 30, handle: 'itisArta' },
  { place: 31, handle: 'Reponts' },
  { place: 32, handle: 'ToyYellow' },
  { place: 33, handle: 'Sadeghammsy666' },
  { place: 34, handle: 'onupu' },
  { place: 35, handle: 'ForeverRich63' },
  { place: 36, handle: 'BlackChayok' },
  { place: 37, handle: 'Chiller228' },
  { place: 38, handle: 'ImMohaseli' },
  { place: 39, handle: 'kandelousi72' },
  { place: 40, handle: 'ZLOY_morti_1' },
  { place: 41, handle: 'yz105' },
  { place: 42, handle: 'ALI_WEH' },
  { place: 43, handle: 'eldando8' },
  { place: 44, handle: 'xeyora67' },
  { place: 45, handle: 'Amfevitominov' },
  { place: 46, handle: 'Slipper777' },
  { place: 47, handle: 'ABCDE145' },
  { place: 48, handle: 'Egor4ik444' },
  { place: 49, handle: 'Tatieanna0' },
  { place: 50, handle: 'v_orenhova' },
  { place: 51, handle: 'Leilyantus' },
  { place: 52, handle: 'Paukf' },
  { place: 53, handle: 'IAMKANEKIKENGHOUL' },
  { place: 54, handle: 'feryshoo' },
  { place: 55, handle: 'JustIbis' },
  { place: 56, handle: 'Invalidysik' },
  { place: 57, handle: 'azot7472' },
  { place: 58, handle: 'ks2525265' },
  { place: 59, handle: 'mAkS_emYS' },
  { place: 60, handle: 'Reskember_official' },
  { place: 61, handle: 'soniya1448' },
  { place: 62, handle: 'gettyw' },
  { place: 63, handle: 'Tima904' },
  { place: 64, handle: 'ulbogdan67' },
  { place: 65, handle: 'Demid5189' },
  { place: 66, handle: 'YMEP_OT_EE_KPACOT' },
  { place: 67, handle: 'DHJGKcd' },
  { place: 68, handle: 'Konstantinkptu890' },
  { place: 69, handle: 'Krakerq' },
  { place: 70, handle: 'Definebymonk' },
  { place: 71, handle: 'Reihanehx' },
  { place: 72, handle: 'Svaga148867228' },
  { place: 73, handle: 'kylltov' },
  { place: 74, handle: 'Naznakomka' },
  { place: 75, handle: 'grebenuk17' },
  { place: 76, handle: 'Samuelfly777giftstarsin' },
  { place: 77, handle: 'EsiPtyPaaz' },
  { place: 78, handle: 'Heppt7' },
  { place: 80, handle: 'Miladovilaa' },
  { place: 81, handle: 'toagov' },
  { place: 82, handle: 'ImFUDU' },
  { place: 83, handle: 'Mustang2013' },
  { place: 84, handle: 'ziwaze' },
  { place: 85, handle: 'ShadowFiend73829297' },
  { place: 86, handle: 'zS0NCH0US' },
  { place: 87, handle: 'Serikow228' },
  { place: 88, handle: 'puperdance' },
  { place: 89, handle: 'vilka_333_loshka' },
  { place: 90, handle: 'xurunta' },
  { place: 91, handle: 'Nikolay12340' },
  { place: 92, handle: 'BEHA_B_MAKAHE' },
  { place: 93, handle: 'swarwiter' },
  { place: 94, handle: 'bU_sI_n_k_A' },
  { place: 95, handle: 'tropical8' },
  { place: 96, handle: 'A999AA77' },
  { place: 97, handle: 'polocute' },
  { place: 98, handle: 'Klachik23' },
  { place: 99, handle: 'xehepi' },
  { place: 100, handle: 'Tum0049' },
]

const BY_HANDLE = new Map<string, number>(WINNERS.map((w) => [w.handle.toLowerCase(), w.place]))

/** Выдано ВРУЧНУЮ скриптом 25.09 (секция contest-prizes worklog): 1 Pro (ixoho)
 *  + 8×6944 свайпов. Автовыдача для них ставит только маркер — без повторной
 *  выдачи (иначе дубль приза). */
const ALREADY_GRANTED = new Set(
  ['ixoho', 'itisArta', 'onupu', 'BlackChayok', 'xeyora67', 'Slipper777', 'Definebymonk', 'zS0NCH0US', 'A999AA77'].map(
    (h) => h.toLowerCase(),
  ),
)

function markerKey(userId: string): string {
  return `contest:done:${userId}`
}

async function markDone(userId: string, place: number): Promise<void> {
  await db.botSetting
    .upsert({
      where: { key: markerKey(userId) },
      create: { key: markerKey(userId), value: String(place) },
      update: { value: String(place) },
    })
    .catch(() => {})
}

/** Выдача тира — та же логика, что POST /api/panel/subscriptions. */
async function grantTier(userId: string, prize: 'pro' | 'plus', place: number): Promise<void> {
  const days = prize === 'pro' ? PRO_DAYS : PLUS_DAYS
  const u = await db.user.findUnique({
    where: { id: userId },
    select: { tier: true, tierUntil: true },
  })
  if (!u) return
  const now = Date.now()
  const activeUntil = u.tierUntil && u.tierUntil.getTime() > now ? u.tierUntil.getTime() : 0
  // Активный Pro + приз Plus → даунгрейда нет: продлеваем Pro
  if (prize === 'plus' && u.tier === 'pro' && activeUntil > 0) {
    const until = new Date(activeUntil + days * DAY_MS)
    await db.user.update({ where: { id: userId }, data: { tierUntil: until } })
    await logAdmin('tier_extend', userId, { tier: 'pro', days, until: until.toISOString(), contest: true, place })
    return
  }
  const extend = u.tier === prize && activeUntil > 0
  const until = new Date((extend ? activeUntil : now) + days * DAY_MS)
  await db.user.update({ where: { id: userId }, data: { tier: prize, tierUntil: until } })
  await logAdmin(extend ? 'tier_extend' : 'tier_grant', userId, {
    tier: prize,
    days,
    until: until.toISOString(),
    contest: true,
    place,
  })
}

/** Выдача свайпов — атомарный increment (тот же кошелёк User.swipes, что
 *  правит панель) + запись в истории кошелька. */
async function grantSwipes(userId: string, place: number): Promise<void> {
  const updated = await db.user.update({
    where: { id: userId },
    data: { swipes: { increment: SWIPES_EACH } },
    select: { swipes: true },
  })
  await db.balanceLog
    .create({
      data: {
        userId,
        kind: 'admin',
        currency: 'swp',
        amount: SWIPES_EACH,
        note: `Приз конкурса — свайпы (место ${place})`,
      },
    })
    .catch(() => {})
  await logAdmin('swipes', userId, {
    delta: SWIPES_EACH,
    swipes: updated.swipes,
    reason: `Приз конкурса (место ${place})`,
    contest: true,
  })
}

/**
 * Проверить победителя и выдать приз один раз. НИКОГДА не бросает — вызывается
 * fire-and-forget из POST /api/auth; любая ошибка только в лог.
 */
export async function maybeGrantContestPrize(user: { id: string; username: string | null }): Promise<void> {
  try {
    const username = user.username?.trim()
    if (!username) return
    const place = BY_HANDLE.get(username.toLowerCase())
    if (place === undefined) return

    // Create-lock ДО выдачи: параллельный инстанс ловит P2002 и выходит
    try {
      await db.botSetting.create({ data: { key: markerKey(user.id), value: String(place) } })
    } catch {
      return // маркер уже стоит — приз выдан/выдаётся другим инстансом
    }

    if (ALREADY_GRANTED.has(username.toLowerCase())) return // выдано вручную ранее

    if (place <= 13) await grantTier(user.id, 'pro', place)
    else if (place <= 18) await grantTier(user.id, 'plus', place)
    else await grantSwipes(user.id, place)

    console.log(`[contest-grants] place ${place} → @${username} (${user.id})`)
  } catch (e) {
    console.error('[contest-grants]', e)
  }
}
