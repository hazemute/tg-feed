#!/usr/bin/env node
/**
 * Vercel deployment cleanup — держит «Function storage» минимальным.
 *
 * Проблема: каждый деплой хранит свои serverless-функции (~сотни МБ) до
 * удаления деплоя. При частых релизах на Hobby-тарифе набегают десятки ГБ.
 *
 * Решение: для каждого проекта аккаунта оставляем только `--keep` штук
 * самых свежих READY production-деплоев (по умолчанию 1 — текущий прод),
 * всё остальное (старые проды, превью, ERROR/CANCELED) удаляем.
 *
 * Использование:
 *   VERCEL_TOKEN=vercel_xxx node scripts/vercel-cleanup.mjs [опции]
 *
 * Опции:
 *   --keep N             сколько свежих production-деплоев хранить (по умолчанию 1)
 *   --older-than-hours H дополнительно щадить деплои моложе H часов (по умолчанию 0)
 *   --dry-run            только показать план, ничего не удалять
 *
 * Примеры:
 *   node scripts/vercel-cleanup.mjs --dry-run
 *   node scripts/vercel-cleanup.mjs                 # оставить только текущий прод
 *   VERCEL_TOKEN=... node scripts/vercel-cleanup.mjs --keep 2 --older-than-hours 6
 *
 * Токен: https://vercel.com/account/tokens (достаточно скоупа deployments).
 * В GitHub Actions запускается ежедневно (см. .github/workflows/vercel-cleanup.yml),
 * токен лежит в repo secret VERCEL_TOKEN.
 */

const API = "https://api.vercel.com";

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const TOKEN = process.env.VERCEL_TOKEN;
if (!TOKEN) {
  console.error("✗ VERCEL_TOKEN не задан (https://vercel.com/account/tokens)");
  process.exit(1);
}

const KEEP = Math.max(1, parseInt(flag("keep", "1"), 10) || 1);
const SAFETY_HOURS = parseFloat(flag("older-than-hours", "0")) || 0;
const DRY = has("dry-run");
let TEAM = process.env.VERCEL_TEAM_ID || "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init) {
  const url = `${API}${path}${path.includes("?") ? "&" : "?"}teamId=${TEAM}`;
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${init?.method || "GET"} ${path} → ${res.status} ${body.slice(0, 200)}`);
  }
  return res.status === 204 ? {} : res.json();
}

async function paginate(path, key) {
  const out = [];
  let until;
  for (let i = 0; i < 50; i++) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await api(`${path}${sep}limit=100${until ? `&until=${until}` : ""}`);
    const items = data[key] || [];
    out.push(...items);
    until = data.pagination?.until;
    if (!until || !items.length) break;
    await sleep(150);
  }
  return out;
}

async function main() {
  // 0. Кто мы и какой team по умолчанию (api() без teamId работает только для
  //    /v2/user, поэтому определяем team до всех остальных вызовов)
  if (!TEAM) {
    const res = await fetch(`${API}/v2/user`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) throw new Error(`/v2/user → ${res.status} (токен невалиден?)`);
    const me = await res.json();
    TEAM = me.user?.defaultTeamId || "";
    console.log(`аккаунт: ${me.user?.username}${TEAM ? ` · team: ${TEAM}` : ""}`);
  }

  console.log(
    `vercel-cleanup: keep=${KEEP} prod, safety=${SAFETY_HOURS}h${DRY ? " · DRY-RUN" : ""}`
  );

  // 1. Все проекты
  const projects = await paginate("/v9/projects", "projects");
  if (!projects.length) {
    console.log("проектов нет — чистить нечего");
    return;
  }

  let deleted = 0, failed = 0, kept = 0;

  for (const p of projects) {
    // 2. Все деплои проекта
    const deploys = await paginate(`/v6/deployments?projectId=${p.id}`, "deployments");
    if (!deploys.length) {
      console.log(`· ${p.name}: деплоев нет`);
      continue;
    }

    // 3. Кто живой прод (по свежести), кто мусор
    const readyProd = deploys
      .filter((d) => d.state === "READY" && d.target === "production")
      .sort((a, b) => b.createdAt - a.createdAt);
    const keepUids = new Set(readyProd.slice(0, KEEP).map((d) => d.uid));
    const nowMs = Date.now();
    const victims = deploys.filter((d) => {
      if (keepUids.has(d.uid)) return false;
      if (SAFETY_HOURS > 0 && nowMs - d.createdAt < SAFETY_HOURS * 3600 * 1000) return false;
      return true;
    });

    const fmt = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
    console.log(`· ${p.name}: всего ${deploys.length}, храним ${keepUids.size} прод (${[...keepUids].join(", ")}), к удалению ${victims.length}`);

    // 4. Удаляем
    for (const d of victims) {
      if (DRY) {
        console.log(`  [dry] ${d.uid} ${d.state} ${d.target || "preview"} ${fmt(d.createdAt)}`);
        deleted++;
        continue;
      }
      try {
        await api(`/v13/deployments/${d.uid}`, { method: "DELETE" });
        console.log(`  ✓ удалён ${d.uid} ${d.state} ${fmt(d.createdAt)}`);
        deleted++;
      } catch (e) {
        console.log(`  ✗ ${d.uid}: ${e.message}`);
        failed++;
      }
      await sleep(300);
    }
    kept += keepUids.size;
  }

  console.log(`\nитог: удалено ${deleted}, хранится ${kept}${failed ? `, ОШИБОК ${failed}` : ""}`);
  if (failed) process.exit(2);
}

main().catch((e) => {
  console.error("✗", e.message);
  process.exit(1);
});
