/**
 * Регистрация домена миниаппа у бота: menu button + описание.
 * Запуск: bun run scripts/set-bot-menu.ts [url]
 */
const TOKEN = process.env.TELEGRAM_BOT_TOKEN!
const url = process.argv[2] ?? 'https://tg-swipe.vercel.app'

async function call(method: string, body: unknown) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  console.log(method, '→', json.ok ? 'OK' : JSON.stringify(json))
  return json
}

await call('setChatMenuButton', {
  menu_button: { type: 'web_app', text: 'Открыть Tg Swipe', web_app: { url } },
})
await call('setMyShortDescription', {
  short_description: 'Умная лента публичных Telegram-каналов: свайпайте посты, подписывайтесь в один тап.',
})
await call('setMyDescription', {
  description: `Tg Swipe — агрегатор постов публичных каналов. Миниапп: ${url}`,
})
console.log('домен миниаппа:', url)
export {}
