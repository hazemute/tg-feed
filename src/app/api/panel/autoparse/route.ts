import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJson, err } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'
import {
  autodiscoverState,
  autodiscoverStep,
  startAutodiscover,
  stopAutodiscover,
  type AutodiscoverSource,
} from '@/lib/autodiscover'

export const dynamic = 'force-dynamic'
export const maxDuration = 60 // шаг может занять до ~30с (3 кандидата × fetch t.me)

/**
 * Автосбор каналов: старт → шаги → стоп. Клиент (панель) сам ведёт цикл
 * шагов, пока state.running — каждый шаг обрабатывает до 3 кандидатов
 * (fetch t.me/s + Bot API) и возвращает свежий прогресс. Состояние в Redis:
 * переживает холодные старты серверлесс-функций.
 *
 * POST { action: 'start', maxNew?: number } — новый сбор (каталог + обход графа)
 *     { action: 'step', batch?: number }     — обработать следующую пачку
 *     { action: 'stop' }                     — мягкая остановка
 * GET  — текущее состояние (для восстановления вкладки)
 */

const postSchema = z.object({
  action: z.enum(['start', 'step', 'stop']),
  maxNew: z.number().int().min(5).max(300).optional(),
  batch: z.number().int().min(1).max(6).optional(),
  source: z.enum(['all', 'tgstat', 'combot', 'curated']).optional(),
})

export async function GET(request: Request) {
  const g = guardAdmin(request, { limit: 120, windowMs: 60_000, bucket: 'autoparse-get' })
  if (!g.ok) return g.res

  const state = await autodiscoverState()
  return NextResponse.json({ ok: true, state })
}

export async function POST(request: Request) {
  const g = guardAdmin(request, { limit: 240, windowMs: 60_000, bucket: 'autoparse-post' })
  if (!g.ok) return g.res

  try {
    const parsed = postSchema.safeParse(await readJson(request))
    if (!parsed.success) return err('action: start | step | stop')
    const { action, maxNew, batch, source } = parsed.data

    if (action === 'start') {
      const r = await startAutodiscover(maxNew, source ?? 'all')
      if (!r.ok) return err(r.reason ?? 'не удалось запустить', 409)
      const state = await autodiscoverState()
      return NextResponse.json({ ok: true, state })
    }

    if (action === 'step') {
      const state = await autodiscoverStep(batch ?? 3)
      if (!state) return err('сбор не запускался', 409)
      return NextResponse.json({ ok: true, state })
    }

    // stop
    const state = await stopAutodiscover()
    return NextResponse.json({ ok: true, state })
  } catch (e) {
    console.error('[panel/autoparse]', e)
    return err('autoparse failed', 500)
  }
}
