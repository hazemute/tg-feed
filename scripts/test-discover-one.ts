/**
 * Диагностика v5.77: discoverSingleChannel против реального t.me (SQLite-песочница).
 * Запуск: bun -e scripts/test-discover-one.ts <username>
 */
process.env.DATABASE_URL ||= 'file:./db/dev.db'

async function main() {
  const username = process.argv[2] ?? 'igromania'
  const { discoverSingleChannel } = await import('../src/lib/autodiscover')
  const { parseChannelHtml } = await import('../src/lib/parse-engine')
  const { getChatInfo, getChatMemberCount } = await import('../src/lib/tg-bot')

  console.log('--- 1. fetch t.me/s ---')
  const res = await fetch(`https://t.me/s/${username}`, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'ru,en;q=0.9',
    },
    signal: AbortSignal.timeout(15000),
  }).catch((e) => null)
  if (!res) return console.log('FETCH FAILED')
  console.log('HTTP', res.status)
  const html = await res.text()
  console.log('html size', html.length)

  console.log('--- 2. parseChannelHtml ---')
  const posts = parseChannelHtml(html, username)
  console.log('parsed posts:', posts.length)

  console.log('--- 3. getChatInfo / getChatMemberCount ---')
  const chat = await getChatInfo(username).catch((e) => { console.log('getChat err', String(e)); return null })
  console.log('chat:', chat ? { id: chat.id, title: chat.title, desc: chat.description?.slice(0, 60) } : null)
  const members = await getChatMemberCount(username).catch((e) => { console.log('members err', String(e)); return null })
  console.log('members:', members)

  console.log('--- 4. discoverSingleChannel ---')
  const r = await discoverSingleChannel(username, 'games')
  console.log('RESULT:', JSON.stringify(r))
  process.exit(0)
}
void main()
