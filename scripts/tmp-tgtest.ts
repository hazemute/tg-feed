import { htmlToMarkdownLite } from '/home/z/my-project/src/lib/markdown'
const html = await Bun.file('/tmp/durov.html').text()
// вырежем сообщения с tg-emoji
const msgs = html.match(/<div class="tgme_widget_message_text[\s\S]*?<\/div>/g) ?? []
let hits = 0
for (const m of msgs) {
  if (!m.includes('tg-emoji')) continue
  hits++
  if (hits > 3) break
  console.log('--- RAW (фрагмент):')
  console.log(m.slice(0, 600).replace(/\s+/g, ' '))
  console.log('--- MARKDOWN:')
  console.log(htmlToMarkdownLite(m).slice(0, 500))
  console.log()
}
console.log('сообщений с tg-emoji:', hits, '/', msgs.length)
