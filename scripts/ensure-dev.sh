#!/bin/bash
# Поднять dev-сервер, если он не отвечает, и дождаться готовности (тёплый кэш)
cd /home/z/my-project
code=$(curl -s -o /dev/null -m 2 -w "%{http_code}" localhost:3000/api/health 2>/dev/null)
if [ "$code" = "200" ]; then
  echo "server already up"
  exit 0
fi
env -u DATABASE_URL -u DIRECT_URL nohup bun run dev > dev.log 2>&1 &
for i in $(seq 1 60); do
  sleep 2
  code=$(curl -s -o /dev/null -m 2 -w "%{http_code}" localhost:3000/api/health 2>/dev/null)
  if [ "$code" = "200" ]; then echo "server ready after ${i} tries"; exit 0; fi
done
echo "server FAILED to start"; tail -20 dev.log; exit 1
