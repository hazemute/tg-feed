/**
 * Хук старта сервера (Next.js instrumentation).
 *
 * При каждом cold start один раз применяет идемпотентные миграции схемы
 * (v5.15 + v5.17). Это чинит «Ошибка входа» на проде: Vercel авто-деплоит
 * код с колонками User.tier / Post.hotScore и т.д., а DDL в Supabase мог
 * не примениться — теперь сервер сам досоздаёт недостающее до первого запроса.
 *
 * SQLite-песочница пропускается (схема накатывается db:push локально).
 *
 * v5.86 — СКОРОСТЬ ХОЛОДНОГО СТАРТА:
 *  1) ensure-schema с verifyFirst: маркер schema_version актуален → ОДИН
 *     SELECT вместо ~154 DDL-roundtrip'ов к Supabase;
 *  2) схема / стерилизация / сид заданий идут ПАРАЛЛЕЛЬНО — суммарная
 *     задержка старта равна самой медленной задаче, а не их сумме. Сид и
 *     стерилизация не зависят друг от друга, а их сбой не мешает схеме
 *     (оба ловят свои ошибки и досчитывают позже из /api/quests и heartbeat).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const bootSchema = async (): Promise<void> => {
    try {
      const { ensureAppSchema } = await import('@/lib/ensure-schema')
      /*
       * verifyFirst: если в SystemSetting.schema_version записана последняя
       * версия миграций — схема гарантированно накатена целиком (маркер
       * ставит тот же прогон, что выполнил все стейтменты). Новая миграция в
       * MIGRATIONS сама «сдвигает» latest — маркер перестанет совпадать и
       * следующий cold start честно накатит всё.
       */
      const r = await ensureAppSchema({ force: true, verifyFirst: true })
      console.log(
        '[boot] ensure-schema:',
        r.ok ? 'ok' : `MISSING: ${r.missing.join(', ')}`,
        `(applied ${r.applied})`,
      )
    } catch (e) {
      console.error('[boot] ensure-schema failed:', e)
    }
  }

  // Стерилизация: гости/демо-балансы удалены из кода входа — подчистить
  // исторические демо-данные (идемпотентно, после чистки удаляет 0 строк).
  const bootSterilize = async (): Promise<void> => {
    try {
      const { purgeDemoData } = await import('@/lib/sterilize')
      const p = await purgeDemoData()
      if (p.guests > 0 || p.fakeEscrow > 0) {
        console.log('[boot] sterilize:', JSON.stringify(p.details))
      }
    } catch (e) {
      console.error('[boot] sterilize failed:', e)
    }
  }

  // v5.70: сид заданий по умолчанию (create-only по стабильным id: админские
  // правки наград/текстов не перетираются). Гарантированно исполняется и в
  // проде, и локально; при сбое БД на старте досеет из GET /api/quests.
  const bootQuestsSeed = async (): Promise<void> => {
    try {
      const { seedDefaultQuests } = await import('@/lib/quests-seed')
      const s = await seedDefaultQuests({ force: true })
      if (s.created > 0) console.log(`[boot] quests-seed: created ${s.created}, skipped ${s.skipped}`)
    } catch (e) {
      console.error('[boot] quests-seed failed:', e)
    }
  }

  await Promise.all([bootSchema(), bootSterilize(), bootQuestsSeed()])
}
