/**
 * Регистрация webhook'а Telegram-бота (вход на сайт через бота).
 *
 * Использование:
 *   bun run scripts/set-webhook.ts https://tg-swipe.vercel.app/api/bot/webhook
 *   bun run scripts/set-webhook.ts delete   — снять вебхук
 *
 * TELEGRAM_WEBHOOK_SECRET (если задан в env) передаётся в setWebhook как
 * secret_token — Telegram будет эхом слать его в заголовке, вебхук проверяет.
 * TELEGRAM_BOT_TOKEN обязателен.
 */

const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set')
  process.exit(1)
}

const arg = process.argv[2]
const url = arg === 'delete' ? null : arg

if (!url && arg !== 'delete') {
  console.error('Usage: bun run scripts/set-webhook.ts <https://…/api/bot/webhook | delete>')
  process.exit(1)
}

const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || undefined

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    ...(url ? { url } : { url: '' }),
    ...(secret ? { secret_token: secret } : {}),
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
    max_connections: 40,
  }),
  signal: AbortSignal.timeout(15000),
})

const data = (await res.json()) as { ok?: boolean; description?: string; result?: unknown }
console.log(url ? `setWebhook → ${url}` : 'setWebhook → deleted')
console.log(JSON.stringify(data, null, 2))
if (!data.ok) process.exit(1)

// Проверка
const info = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
  signal: AbortSignal.timeout(15000),
}).then((r) => r.json() as Promise<{ ok?: boolean; result?: Record<string, unknown> }>)
console.log('getWebhookInfo:', JSON.stringify(info.result, null, 2))

export {}
