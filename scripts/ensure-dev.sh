#!/bin/bash
# Гарантирует живой dev-сервер на 3000 (платформа его не рестартует после падения)
cd /home/z/my-project
if curl -s -o /dev/null --max-time 3 http://localhost:3000/api/health; then
  echo "dev: up"
  exit 0
fi
echo "dev: down — starting..."
(setsid bun run dev < /dev/null > /dev/null 2>&1 &)
for i in $(seq 1 60); do
  sleep 1
  if curl -s -o /dev/null --max-time 3 http://localhost:3000/api/health; then
    echo "dev: ready after ${i}s"
    exit 0
  fi
done
echo "dev: FAILED to start"
exit 1
