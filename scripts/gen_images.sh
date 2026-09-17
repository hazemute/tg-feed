#!/bin/bash
# TG-Feed media generation (background task 2-a)
mkdir -p /home/z/my-project/public/media
cd /home/z/my-project/public/media || exit 1

gen() {
  local name="$1"; shift
  local prompt="$1"; shift
  if [ -f "$name" ]; then echo "SKIP $name"; return; fi
  z-ai image -p "$prompt" -o "./$name" -s 1152x864 >/dev/null 2>&1 && echo "OK $name" || echo "FAIL $name"
}

gen crypto.png "Golden bitcoin coins stacked on smartphone with glowing green cryptocurrency trading chart in background, dark moody financial photography, shallow depth of field, high quality, detailed"
gen tech.png "Developer laptop with colorful code on screen in dark modern workspace, terminal windows, blue keyboard backlight, cinematic photography, high quality, detailed"
gen news.png "Morning city news concept, newspaper and coffee cup on wooden table, blurred city street through window, soft daylight, editorial photography, high quality"
gen humor.png "Extremely funny surprised cat with wide open eyes sitting at table looking at laptop screen, comedic pet photography, warm indoor light, high quality, detailed"
gen business.png "Modern glass skyscrapers of business district at sunset, upward perspective, warm golden reflections on glass, corporate photography, high quality, detailed"
gen travel.png "Beautiful turquoise alpine lake with wooden pier and mountains at dawn, travel photography, soft pastel sky, misty water, high quality, detailed"
gen food.png "Delicious italian pasta with basil and parmesan on rustic plate, dark wooden table, ingredients around, food photography, appetizing, soft light, high quality"
gen sport.png "Football stadium at night with bright floodlights and green pitch, dramatic view from stands, sports photography, high quality, detailed"
gen ai.png "Futuristic humanoid robot face with glowing neural network patterns, dark background, technology concept art, cinematic lighting, high quality, detailed"
gen market.png "Stock market trading desk with multiple monitors showing red and green candlestick charts, dark office, financial photography, high quality, detailed"

echo "ALL_DONE"
