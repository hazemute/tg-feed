import { NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'
import { guardAuth } from '@/lib/guard'
import { err, readJson } from '@/lib/server'
import { grantQuestCompletion, questLinkFor } from '@/lib/quests'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/quests/[id]/tiktok-verify (v5.70) — умная проверка подписки TikTok.
 *
 * Серверного API TikTok для проверки подписки не существует (их API закрыт для
 * серверов), поэтому проверяем СКРИНШОТ через VLM (z-ai-web-dev-sdk):
 * юзер подписывается на @snapteamdev, делает скриншот профиля/кнопки
 * «Вы подписаны», загружает его через POST /api/upload и присылает сюда URL.
 *
 * Зачёт только при subscribed=true И confidence=high. Анти-абьюз:
 *  • rate-limit 1 попытка / 5 минут на юзера (guardAuth);
 *  • каждая попытка пишется в QuestVerifyLog (аудит + «3 подряд false →
 *    предложение обратиться в поддержку»);
 *  • VLM недоступен/ошибка → честный «проверка временно недоступна» БЕЗ зачёта.
 */

const VERIFY_PROMPT =
  'На скриншоте профиль TikTok @snapteamdev? Признаки ПОДПИСКИ на этот канал ' +
  '(кнопка «Вы подписаны»/«Подписки»/Following вместо «Подписаться»/Follow, ' +
  'или профиль со списком подписок где виден snapteamdev)? ' +
  'Ответь строго JSON {"subscribed": true|false, "confidence": "high"|"low", "reason": "кратко"}'

type VlmVerdict = { subscribed: boolean; confidence: 'high' | 'low'; reason: string }

/** Вытащить JSON из ответа модели (может быть обёрнут в ```json … ``` или текст) */
function extractVerdict(raw: string): VlmVerdict | null {
  if (!raw) return null
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim()
  const candidates = [cleaned, raw]
  for (const s of candidates) {
    const start = s.indexOf('{')
    const end = s.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    try {
      const parsed = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>
      const subscribed = parsed.subscribed === true || parsed.subscribed === 'true'
      const confidence = String(parsed.confidence ?? '').toLowerCase() === 'high' ? 'high' : 'low'
      const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 300) : ''
      return { subscribed, confidence, reason }
    } catch {
      // попробуем следующий кандидат
    }
  }
  return null
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'object' && c && 'text' in c ? String((c as { text?: unknown }).text ?? '') : ''))
      .join('\n')
  }
  return ''
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Анти-абьюз: 1 попытка / 5 минут на юзера (жёстко по вызовам, чтобы
  // не молотить VLM потоком скриншотов)
  const g = guardAuth(request, { limit: 1, windowMs: 5 * 60_000, bucket: 'tiktok-verify' })
  if (!g.ok) return g.res
  const { id } = await params
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return err('bad id', 400)

  try {
    const body = (await readJson(request)) as { url?: unknown }
    const url = typeof body.url === 'string' ? body.url : ''
    const m = url.match(/^\/api\/upload\/([a-zA-Z0-9_-]{8,32})$/)
    if (!m) return err('Ожидается url загруженного скриншота /api/upload/<id>', 400)

    const [quest, upload] = await Promise.all([
      db.quest.findUnique({ where: { id } }),
      db.upload.findUnique({ where: { id: m[1] }, select: { id: true, ownerId: true, mime: true, data: true } }),
    ])
    if (!quest || !quest.active || quest.kind !== 'tiktok_follow') return err('Квест не найден', 404)
    if (!upload || upload.ownerId !== g.uid) return err('Скриншот не найден — загрузите его заново', 404)

    const existing = await db.questCompletion.findUnique({
      where: { questId_userId: { questId: quest.id, userId: g.uid } },
    })
    if (existing) {
      return NextResponse.json({
        status: existing.status === 'done' ? 'already' : 'revoked',
      })
    }

    /* ---------------- VLM: скриншот → вердикт ---------------- */
    let verdict: VlmVerdict | null = null
    let unavailable = false
    try {
      const zai = await ZAI.create()
      const res = (await Promise.race([
        zai.chat.completions.createVision({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: VERIFY_PROMPT },
                { type: 'image_url', image_url: { url: `data:${upload.mime};base64,${upload.data}` } },
              ],
            },
          ],
        } as Parameters<typeof zai.chat.completions.createVision>[0]),
        new Promise<never>((_, rej) => {
          const t = setTimeout(() => rej(new Error('vlm timeout')), 40_000)
          if (typeof t === 'object' && 'unref' in t) (t as { unref: () => void }).unref?.()
        }),
      ])) as { choices?: Array<{ message?: { content?: unknown } }> }
      const text = contentToText(res?.choices?.[0]?.message?.content)
      verdict = extractVerdict(text)
      if (!verdict) unavailable = true
    } catch (e) {
      console.error('[quests/tiktok-verify] vlm error', e)
      unavailable = true
    }

    if (unavailable) {
      // VLM недоступен/мусорный ответ — честный отказ БЕЗ зачёта (попытку логируем)
      await db.questVerifyLog
        .create({ data: { questId: quest.id, userId: g.uid, ok: false, confidence: 'error', reason: 'vlm_unavailable' } })
        .catch(() => {})
      return NextResponse.json(
        {
          status: 'verify_unavailable',
          error: 'Проверка временно недоступна, попробуй позже',
          message: 'Проверка временно недоступна, попробуй позже',
        },
        { status: 503 },
      )
    }

    const link = questLinkFor(quest.kind, quest.target, quest.link)
    const ok = verdict!.subscribed && verdict!.confidence === 'high'

    await db.questVerifyLog
      .create({
        data: {
          questId: quest.id,
          userId: g.uid,
          ok,
          confidence: verdict!.confidence,
          reason: verdict!.reason || null,
        },
      })
      .catch(() => {})

    if (!ok) {
      // «3 подряд false → поддержка»: последние 3 попытки (включая текущую)
      const recent = await db.questVerifyLog
        .findMany({
          where: { questId: quest.id, userId: g.uid },
          orderBy: { createdAt: 'desc' },
          take: 3,
          select: { ok: true },
        })
        .catch(() => [])
      const allFailed = recent.length === 3 && recent.every((r) => !r.ok)
      return NextResponse.json({
        status: verdict!.subscribed ? 'low_confidence' : 'not_subscribed',
        message: verdict!.subscribed
          ? 'Скриншот нечёткий: не удалось уверенно распознать подписку. Сделай скриншот ещё раз — крупнее и целиком с кнопкой «Вы подписаны».'
          : 'Подписка на @snapteamdev не найдена. Подпишись в TikTok и пришли скриншот профиля с кнопкой «Вы подписаны».',
        supportHint: allFailed,
        link,
      })
    }

    // Зачёт: атомарная выдача (как у остальных заданий)
    const balance = await grantQuestCompletion(quest, g.uid)
    if (balance === null) return NextResponse.json({ status: 'already' })
    console.log(`[quests/tiktok-verify] credited user=${g.uid} quest=${quest.id} reason="${verdict!.reason}"`)
    return NextResponse.json({ status: 'done', reward: quest.rewardSwp, balance })
  } catch (e) {
    console.error('[quests/tiktok-verify]', e)
    return err('failed', 500)
  }
}
