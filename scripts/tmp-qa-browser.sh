#!/usr/bin/env bash
# ВРЕМЕННЫЙ QA-скрипт (Task 6-b) — браузерная верификация инлайн-рендера ИИ-картинок.
# Среда флапает (cron-ревьюер + OOM раз в ~15 мин), поэтому всё в одном устойчивом цикле.
cd /home/z/my-project
mkdir -p screenshots
CH='cmub7e1uw0001krbsae467xxa'
TOKEN=$(cat /tmp/token.txt)

ensure_server() {
  local code=$(curl -s -m 4 -o /dev/null -w "%{http_code}" http://localhost:3000/api/health)
  if [ "$code" != "200" ]; then
    setsid nohup node node_modules/next/dist/bin/next dev -p 3000 >> dev.log 2>&1 < /dev/null &
    disown
    for i in $(seq 1 30); do
      sleep 2
      code=$(curl -s -m 4 -o /dev/null -w "%{http_code}" http://localhost:3000/api/health)
      [ "$code" = "200" ] && break
    done
  fi
  echo "server:$code"
}

seed() {
  agent-browser eval "localStorage.setItem('tgfeed_session','$TOKEN'); const CH='$CH'; const now=Date.now(); const msgs=[{id:'m_seed_u1',role:'user',text:'Напиши пост про уютное чтение и нарисуй обложку',at:new Date(now-3600e3).toISOString()},{id:'m_seed_a1',role:'assistant',text:'Готово! Пост про уютное чтение создан, обложка — ниже.',at:new Date(now-3540e3).toISOString(),imageUrl:'/api/upload/cmubeg6rb0001krws0g6i7jr4',imagePending:false,draftText:'Книга, плед и чашка какао — идеальный вечер.',draftTopic:'уютное чтение'},{id:'m_seed_a2',role:'assistant',text:'Рисую вторую иллюстрацию для карусели — минутку.',at:new Date(now-3000e3).toISOString(),imagePending:true}]; localStorage.setItem('snap_ai_chat_assistant_'+CH, JSON.stringify(msgs)); 'seeded'" 2>/dev/null
}

to_chat() {
  agent-browser eval "(()=>{const nav=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Каналы'); nav?.click(); return Boolean(nav)})()" >/dev/null 2>&1
  sleep 1
  agent-browser eval "(()=>{const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='ИИ-ассистент'); btn?.click(); return Boolean(btn)})()" >/dev/null 2>&1
  sleep 2
  agent-browser eval "(()=>{const list=document.querySelector('[role=dialog] .overflow-y-auto'); if(list) list.scrollTop=0; return Boolean(list)})()" 2>/dev/null
}

check_img() {
  agent-browser eval "(()=>{const img=[...document.querySelectorAll('img')].find(i=>i.getAttribute('src')?.includes('/api/upload/')); return JSON.stringify({inChat:Boolean(img),loaded:img?img.complete&&img.naturalWidth>0:false,nw:img?.naturalWidth??0,opacity:img?getComputedStyle(img).opacity:'-',pending:[...document.querySelectorAll('[aria-live=polite]')].some(e=>e.textContent.includes('Рисую'))})})()" 2>/dev/null
}

for attempt in 1 2 3 4 5 6 7 8; do
  echo "===== attempt $attempt $(ensure_server) ====="
  agent-browser open http://localhost:3000 >/dev/null 2>&1
  agent-browser wait --load networkidle --timeout 45000 >/dev/null 2>&1
  seed
  agent-browser reload >/dev/null 2>&1
  agent-browser wait --load networkidle --timeout 60000 >/dev/null 2>&1
  chat=$(to_chat)
  sleep 3
  res=$(check_img)
  echo "chat-open:$chat img:$res"
  echo "$res" | grep -q '"loaded":true' || continue

  # 1) скриншот светлой темы: инлайн-картинка в чате
  agent-browser screenshot screenshots/task6b-chat-inline-light.png >/dev/null 2>&1
  echo "shot-light-inline:ok"

  # 2) клик → лайтбокс
  agent-browser eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.querySelector('img[src*=\\'/api/upload/\\']')); b?.click(); return Boolean(b)})()" 2>/dev/null
  sleep 2
  lb=$(agent-browser eval "(()=>{const lb=document.querySelector('[role=dialog] img, [data-lightbox] img, body > div:empty ~ * img'); const imgs=[...document.querySelectorAll('img')].filter(i=>i.naturalWidth>760); return JSON.stringify({imgs:imgs.length,anyFullscreen:[...document.querySelectorAll('div')].some(d=>d.className.includes&&String(d.className).includes('fixed')&&d.querySelector('img'))})})()" 2>/dev/null)
  echo "lightbox:$lb"
  agent-browser screenshot screenshots/task6b-chat-lightbox-light.png >/dev/null 2>&1
  agent-browser press Escape >/dev/null 2>&1
  sleep 1

  # 3) тёмная тема
  agent-browser eval "localStorage.setItem('tgfeed_theme','dark'); 'dark-set'" >/dev/null 2>&1
  agent-browser reload >/dev/null 2>&1
  agent-browser wait --load networkidle --timeout 60000 >/dev/null 2>&1
  to_chat >/dev/null 2>&1
  sleep 3
  resd=$(check_img)
  echo "dark img:$resd"
  echo "$resd" | grep -q '"loaded":true' || continue
  agent-browser screenshot screenshots/task6b-chat-inline-dark.png >/dev/null 2>&1
  agent-browser eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.querySelector('img[src*=\\'/api/upload/\\']')); b?.click(); return Boolean(b)})()" >/dev/null 2>&1
  sleep 2
  agent-browser screenshot screenshots/task6b-chat-lightbox-dark.png >/dev/null 2>&1
  echo "ALL-QA-DONE"
  break
done
