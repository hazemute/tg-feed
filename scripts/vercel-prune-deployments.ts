/**
 * v5.89: чистка СТАРЫХ деплоев Vercel — метрика «Functions Storage»
 * (28.21 GB / 10 GB) — это суммарный размер бандлов функций ВСЕХ удерживаемых
 * деплоев. Каждый релиз tg-feed держит ~0.5-1 GB бандлов; сотни старых деплоев
 * раздули лимит. Скрипт оставляет последние N (по умолчанию 3) production-деплоя,
 * остальные удаляет через DELETE /v2/deployments/{id}.
 *
 * Запуск: bun scripts/vercel-prune-deployments.ts [keep]
 * Токен читается из /home/z/.secrets/tg-feed-deploy.md (НЕ печатается).
 */

import { readFileSync } from 'node:fs'

function readToken(): string {
  const raw = readFileSync('/home/z/.secrets/tg-feed-deploy.md', 'utf8')
  const m = raw.match(/^VERCEL_TOKEN=(.+)$/m)
  if (!m) throw new Error('VERCEL_TOKEN not found in secrets file')
  return m[1].trim()
}

const PROJECT_ID = 'prj_0LPKNzp6WoubZk1OW726SFBtlPTR'
const KEEP = Number(process.argv[2] ?? '3')
const token = readToken()

type Dep = { uid: string; createdAt: number; readyState: string; target?: string | null }

async function main() {
  // Больше лимита не берём: старьё за пределами 100 удалим на следующем прогоне
  const res = await fetch(
    `https://api.vercel.com/v6/deployments?projectId=${PROJECT_ID}&limit=100&target=production`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) throw new Error(`list failed: ${res.status}`)
  const data = (await res.json()) as { deployments: Dep[] }
  const deps = [...data.deployments].sort((a, b) => b.createdAt - a.createdAt)

  console.log(`production deployments: ${deps.length}, keeping ${KEEP}`)

  let deleted = 0
  let freedHint = 0
  for (const d of deps.slice(KEEP)) {
    const r = await fetch(`https://api.vercel.com/v2/deployments/${d.uid}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (r.ok || r.status === 204) {
      deleted++
      freedHint++
      console.log(`deleted ${d.uid} (${new Date(d.createdAt).toISOString().slice(0, 10)}, ${d.readyState})`)
    } else {
      const body = await r.text().catch(() => '')
      console.log(`skip ${d.uid}: HTTP ${r.status} ${body.slice(0, 120)}`)
    }
  }
  console.log(`done: deleted=${deleted}, kept=${Math.min(KEEP, deps.length)}`)
}

main().catch((e) => {
  console.error('prune failed:', (e as Error).message)
  process.exit(1)
})
