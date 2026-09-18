/** Разовый фикс: title из getChat для каналов, где title == username */
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? ''
async function main() {
  const chs = await db.channel.findMany({ select: { id: true, username: true, title: true, description: true } })
  for (const c of chs) {
    if (c.title.toLowerCase() !== c.username.toLowerCase()) continue
    try {
      const res = await fetch(`https://api.telegram.org/bot${TOKEN}/getChat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: `@${c.username}` }), signal: AbortSignal.timeout(10_000),
      })
      const data = (await res.json()) as { ok?: boolean; result?: { title?: string; description?: string } }
      const t = data?.result?.title
      const d = data?.result?.description
      if (data?.ok && t) {
        await db.channel.update({ where: { id: c.id }, data: { title: t, ...(d && !c.description ? { description: d } : {}) } })
        console.log(`fixed: @${c.username} → «${t}»`)
      } else {
        console.log(`skip: @${c.username} (getChat not ok)`)
      }
    } catch { console.log(`skip: @${c.username} (fetch fail)`) }
  }
  await db.$disconnect()
}
main()
