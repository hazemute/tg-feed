#!/bin/bash
# Один вызов: поднять сервер (если мёртв), задать сессию, открыть профиль,
# проверить кошелёк (вкладки/конвертация/история/пополнение) и снять скриншоты.
cd /home/z/my-project
TOK=$(cat /tmp/tok.txt)

code=$(curl -s -o /dev/null -m 5 -w "%{http_code}" localhost:3000/api/health 2>/dev/null)
if [ "$code" != "200" ]; then
  echo "starting server..."
  env -u DATABASE_URL -u DIRECT_URL nohup bun run dev > dev.log 2>&1 &
fi
for i in $(seq 1 45); do
  code=$(curl -s -o /dev/null -m 5 -w "%{http_code}" localhost:3000/api/health 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "health: $code"

AB="agent-browser"
$AB open "http://localhost:3000" 2>&1 | tail -1
sleep 2
$AB eval "localStorage.setItem('tgfeed_session', '$TOK'); 'token set'" 2>&1 | tail -1
$AB open "http://localhost:3000" 2>&1 | tail -1
sleep 8

echo "=== 1. Лента загрузилась? ==="
$AB eval "document.body.innerText.slice(0,160).replace(/\n/g,' | ')" 2>&1 | tail -2

echo "=== 2. Переход в профиль (клик по табу Профиль) ==="
$AB eval "(()=>{const b=[...document.querySelectorAll('button,a')].find(x=>/профиль/i.test(x.textContent||'')&&x.offsetParent); if(b){b.click(); return 'clicked: '+b.textContent.trim()} return 'NOT FOUND'})()" 2>&1 | tail -1
sleep 3

echo "=== 3. Кошелёк в профиле ==="
$AB eval "(()=>{const t=document.body.innerText; const i=t.indexOf('Кошелёк'); return i<0?'NO WALLET SECTION':t.slice(i,i+260).replace(/\n/g,' | ')})()" 2>&1 | tail -2

echo "=== 4. Вкладка Свайпы ==="
$AB eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('role')==='tab'&&/Свайпы/.test(x.textContent||'')); if(b){b.click(); return 'tab clicked'} return 'NO TAB'})()" 2>&1 | tail -1
sleep 1
$AB eval "(()=>{const t=document.body.innerText; const i=t.indexOf('Кошелёк'); return t.slice(i,i+300).replace(/\n/g,' | ')})()" 2>&1 | tail -2

echo "=== 5. Скриншот кошелька (вкладка Свайпы) ==="
$AB screenshot /home/z/my-project/shots/wallet-swp.png 2>&1 | tail -1

echo "=== 6. Обмен свайпов в рубли ==="
$AB eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Обменять в рубли/.test(x.textContent||'')); if(b){b.click(); return 'convert clicked'} return 'NO BTN'})()" 2>&1 | tail -1
sleep 2
$AB eval "(()=>{const t=document.body.innerText; const i=t.indexOf('Кошелёк'); return t.slice(i,i+300).replace(/\n/g,' | ')})()" 2>&1 | tail -2

echo "=== 7. Вкладка Рубли + история ==="
$AB eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('role')==='tab'&&/Рубли/.test(x.textContent||'')); if(b){b.click(); return 'rub tab'} return 'NO'})()" 2>&1 | tail -1
sleep 1
$AB eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/История операций/.test(x.textContent||'')); if(b){b.click(); return 'history opened'} return 'NO HISTORY BTN'})()" 2>&1 | tail -1
sleep 1
$AB eval "(()=>{const t=document.body.innerText; const i=t.indexOf('Кошелёк'); return t.slice(i,i+420).replace(/\n/g,' | ')})()" 2>&1 | tail -2

echo "=== 8. Скриншот (вкладка Рубли + история) ==="
$AB screenshot /home/z/my-project/shots/wallet-rub.png 2>&1 | tail -1

echo "=== 9. Шторка пополнения ==="
$AB eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Пополнить/.test(x.textContent||'')); if(b){b.click(); return 'topup clicked'} return 'NO'})()" 2>&1 | tail -1
sleep 2
$AB eval "document.body.innerText.slice(0,320).replace(/\n/g,' | ')" 2>&1 | tail -2
$AB screenshot /home/z/my-project/shots/topup.png 2>&1 | tail -1

echo "=== 10. API-сверка баланса после конвертаций ==="
TOK="$TOK" curl -s localhost:3000/api/wallet -H "Authorization: Bearer $TOK" | head -c 200
echo
