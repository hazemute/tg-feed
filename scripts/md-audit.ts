import { db } from '../src/lib/db'
import { blocksOf, spansOf } from '../src/lib/markdown'

/** Видимый текст рендера: спаны → строки (спойлеры/ссылки/эмодзи разворачиваем) */
function visibleText(text: string): string {
  const blocks = blocksOf(text)
  let out = ''
  const walk = (spans: any[]) => {
    for (const s of spans) {
      if (s.t === 'emoji') { out += '[EMOJI]'; continue }
      if ('kids' in s && s.kids?.length) walk(s.kids)
      else out += s.v ?? ''
    }
  }
  const walkSpans = (spans: any[] | undefined) => {
    if (!spans) return
    walk(spans)
    out += '\n'
  }
  for (const b of blocks) {
    switch (b.type) {
      case 'code': out += b.v + '\n'; break
      case 'hr': out += '\n'; break
      case 'p':
      case 'heading':
      case 'quote': walkSpans(b.spans); break
      case 'list': for (const item of b.items) walkSpans(item); break
      case 'todo': for (const item of b.items) walkSpans(item.spans); break
      case 'table':
        for (const cell of b.header ?? []) walkSpans(cell)
        for (const row of b.rows) for (const cell of row) walkSpans(cell)
        break
    }
  }
  return out
}

const PATTERNS: Array<[string, RegExp]> = [
  ['bold ** leftover', /\*\*/],
  ['italic __ leftover', /__/],
  ['strike ~~ leftover', /~~/],
  ['spoiler || leftover', /\|\|/],
  ['underline ^^ leftover', /\^\^/],
  ['broken link ](', /\]\(https?:/],
  ['unparsed emoji ![e', /!\[e/],
  ['html tag leftover', /<(?:br|b>|i>|s>|u>|a |code|pre|span|tg-)/i],
  ['entity &amp;', /&(?:amp|lt|gt|quot|#39|nbsp);/],
  ['markdown link [text](url) leftover', /\[[^\]\n]{1,60}\]\([^)\s]{1,120}\)/],
  ['url in visible text', /https?:\/\/[^\s]+\.[a-z]{2,}/i],
  ['orphan code backtick', /`[^`]{1,200}`/],
]

async function main() {
  const posts = await db.post.findMany({ select: { id: true, text: true, tgKey: true } })
  console.log('posts:', posts.length)
  const hits = new Map<string, Array<{ id: string; sample: string }>>()
  for (const p of posts) {
    if (!p.text) continue
    const vis = visibleText(p.text)
    for (const [name, re] of PATTERNS) {
      if (re.test(vis)) {
        const arr = hits.get(name) ?? []
        if (arr.length < 40) arr.push({ id: p.id, sample: vis.slice(Math.max(0, vis.search(re) - 40), vis.search(re) + 60).replace(/\n/g, '⏎') })
        hits.set(name, arr)
      }
    }
  }
  console.log('=== РЕЗУЛЬТАТЫ (посты с проблемами) ===')
  for (const [name, arr] of hits) {
    console.log(`\n## ${name}: ${arr.length} постов`)
    for (const a of arr) console.log(`   [${a.id}] …${a.sample}…`)
  }
  process.exit(0)
}
main()
