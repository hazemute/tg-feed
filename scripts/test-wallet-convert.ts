/**
 * Юнит-проверка v5.61: конвертация свайпы↔копейки (фикс ×100 рубли/копейки).
 * Запуск: bun scripts/test-wallet-convert.ts
 */
import { swpToKop, kopToSwp, SWP_PER_RUB, SWP_PER_KOP, swipesForUsage } from '../src/lib/wallet'

let fail = 0
function eq(name: string, got: number | string, want: number | string): void {
  const ok = got === want
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got=${got} want=${want}`)
}

// Константы курса
eq('SWP_PER_RUB', SWP_PER_RUB, 500)
eq('SWP_PER_KOP (1 копейка = 5 свайпов)', SWP_PER_KOP, 5)

// swp2rub: ГЛАВНЫЙ КЕЙС ВЛАДЕЛЬЦА — 100 000 свайпов = 200 ₽ (20 000 коп.), а не 2 ₽
eq('100000 свайпов → 20000 коп (200 ₽)', swpToKop(100000), 20000)
eq('500 свайпов → 100 коп (1 ₽)', swpToKop(500), 100)
eq('1000 свайпов → 200 коп (2 ₽)', swpToKop(1000), 200)
eq('505 свайпов → 101 коп (округление вверх)', swpToKop(505), 101)
eq('1 свайп → 1 коп (ceil)', swpToKop(1), 1)

// rub2swp: обратно, без потерь на круглых суммах
eq('20000 коп → 100000 свайпов', kopToSwp(20000), 100000)
eq('100 коп → 500 свайпов', kopToSwp(100), 500)
eq('1 коп → 5 свайпов', kopToSwp(1), 5)
eq('0 коп → 0 свайпов', kopToSwp(0), 0)

// Иммунитет к путанице: прямое и обратное преобразование круглого рубля — тождественно
for (const rub of [1, 2, 10, 200, 1000]) {
  const kop = rub * 100
  eq(`roundtrip ${rub} ₽`, kopToSwp(swpToKop(kop * (SWP_PER_RUB / 100)) / (SWP_PER_RUB / 100)), kop)
}

// Тарификация ИИ не задета
eq('usage: 1млн in → 1 свайп', swipesForUsage({ promptTokens: 1_000_000, completionTokens: 0 }), 1000)
eq('usage: мин 1 свайп', swipesForUsage({ promptTokens: 0, completionTokens: 0 }), 1)

if (fail > 0) {
  console.error(`\n${fail} проверок провалено`)
  process.exit(1)
}
console.log('\nВсе проверки конвертации пройдены')
