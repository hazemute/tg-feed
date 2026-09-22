/** QA: соседи по лидерборду (не гости) — проверка подиума/таблицы. Удалить перед коммитом. */
import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const rivals = [
  { id: 'lb_alpha', username: 'lb_alpha', firstName: 'Аня', isGuest: false, xp: 5000, level: 9, swipes: 12000 },
  { id: 'lb_bravo', username: 'lb_bravo', firstName: 'Борис', isGuest: false, xp: 3200, level: 8, swipes: 8000 },
  { id: 'lb_charlie', username: 'lb_charlie', firstName: 'Вера', isGuest: false, xp: 2100, level: 7, swipes: 40000 },
  { id: 'lb_delta', username: 'lb_delta', firstName: 'Гоша', isGuest: false, xp: 800, level: 4, swipes: 900 },
  { id: 'lb_echo', username: 'lb_echo', firstName: 'Даша', isGuest: false, xp: 300, level: 3, swipes: 300 },
]
try {
  for (const r of rivals) {
    await p.user.upsert({ where: { id: r.id }, update: r, create: r })
  }
  await p.user.update({ where: { id: 'qa_wallet_tester' }, data: { xp: 1240, level: 6 } })
  console.log('seeded 5 rivals + qa xp=1240')
} catch (e) { console.error('ERR:', e instanceof Error ? e.message : String(e)) } finally { await p.$disconnect() }
