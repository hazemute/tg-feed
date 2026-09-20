/**
 * E2E-проверка ЖИВОЙ БАЗЫ ЗНАНИЙ ИИ (v5.47).
 * Запуск: bun scripts/test-ai-knowledge.ts
 *
 * Проверяет:
 *  1. Сборка базы: статические факты (тарифы/курс/лимиты) + живые (БД).
 *  2. Снапшот пишется в SystemSetting('ai_knowledge') и переиспользуется
 *     (хэш совпал → повторный вызов не пересобирает).
 *  3. Инвалидация: после invalidateAiKnowledge() база читается из БД.
 *  4. Изменение розыгрыша (создание активного) → новый хэш → пересборка,
 *     розыгрыш появляется в блоке знаний; после теста — удаление.
 *  5. Блоки для промптов: full (поддержка/ассистент) и compact (поиск).
 *  6. Промпт поддержки содержит факты из базы и не содержит {{KNOWLEDGE}}.
 */
import { db } from '../src/lib/db'
import {
  getAiKnowledge,
  invalidateAiKnowledge,
  knowledgeBlock,
} from '../src/lib/ai-knowledge'
import { supportSystemPrompt } from '../src/lib/support-ai'
import { APP_VERSION } from '../src/lib/version'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, extra = '') {
  if (ok) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name} ${extra}`)
  }
}

async function main() {
  console.log(`=== Живая база знаний ИИ (v${APP_VERSION}) ===`)

  // 1) первая сборка
  invalidateAiKnowledge()
  const t0 = Date.now()
  const kb1 = await getAiKnowledge()
  const buildMs = Date.now() - t0
  check('первая сборка вернула снапшот', Boolean(kb1.hash && kb1.full && kb1.compact))
  check(`сборка быстрая (${buildMs}мс)`, buildMs < 5000)
  check('версия в снапшоте совпадает', kb1.version === APP_VERSION)

  // факты в полном блоке
  check('курс свайпов в знаниях', kb1.full.includes('500 свайпов = 1 ₽'))
  check('тарифы Plus/Pro в знаниях', kb1.full.includes('Snap Plus') && kb1.full.includes('Snap Pro'))
  check('лимит поиска в знаниях', kb1.full.includes('3 ИИ-поиска'))
  check('версия приложения в знаниях', kb1.full.includes(APP_VERSION))
  check('живая статистика в знаниях', /каналов/.test(kb1.live))
  check('категории в знаниях', /Категории ленты/.test(kb1.full))

  // 2) снапшот в БД
  const row = await db.systemSetting.findUnique({ where: { key: 'ai_knowledge' } })
  check('снапшот записан в SystemSetting', Boolean(row))
  if (row) {
    const snap = JSON.parse(row.value) as { hash: string }
    check('хэш в БД = хэш в памяти', snap.hash === kb1.hash)
  }

  // 3) повторный вызов — из кэша (тот же объект)
  const kb2 = await getAiKnowledge()
  check('повторный вызов отдаёт тот же хэш', kb2.hash === kb1.hash)

  // 4) тестовый активный розыгрыш → пересборка с ним
  const gw = await db.giveaway.create({
    data: {
      title: 'Тест базы знаний ИИ',
      prizes: JSON.stringify([{ kind: 'swipes', amount: 1000, winners: 1 }]),
      startAt: new Date(Date.now() - 3_600_000),
      endAt: new Date(Date.now() + 3_600_000),
      status: 'active',
      tasks: JSON.stringify([{ kind: 'activity', enabled: true, tickets: 2, swipeGoal: 10 }]),
    },
  })
  invalidateAiKnowledge()
  const kb3 = await getAiKnowledge()
  check('новый розыгрыш меняет хэш', kb3.hash !== kb1.hash)
  check('розыгрыш появился в знаниях', kb3.full.includes('Тест базы знаний ИИ'))
  check('призы розыгрыша в знаниях', kb3.full.includes('1000'))

  // 5) блоки для промптов
  const full = await knowledgeBlock('full')
  const compact = await knowledgeBlock('compact')
  check('full-блок содержит розыгрыш', full.includes('Тест базы знаний ИИ'))
  check('compact-блок короче полного', compact.length < full.length)
  check('compact-блок содержит тарифы', compact.includes('Snap Plus'))

  // 6) промпт поддержки
  const sp = await supportSystemPrompt()
  check('промпт поддержки без плейсхолдера', !sp.includes('{{KNOWLEDGE}}'))
  check('промпт поддержки с фактами (курс)', sp.includes('500 свайпов = 1 ₽'))
  check('промпт поддержки с розыгрышем', sp.includes('Тест базы знаний ИИ'))
  check('промпт поддержки с эскалацией', sp.includes('[ESCALATE]'))

  // уборка
  await db.giveaway.delete({ where: { id: gw.id } })
  invalidateAiKnowledge()
  const kb4 = await getAiKnowledge()
  check('после удаления розыгрыша он исчез из знаний', !kb4.full.includes('Тест базы знаний ИИ'))

  console.log(`\nИтог: ${pass} ok, ${fail} fail`)
  process.exit(fail > 0 ? 1 : 0)
}

main()
  .catch((e) => {
    console.error('Тест упал:', e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
