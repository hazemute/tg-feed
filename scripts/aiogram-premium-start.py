"""
Tg Swipe — приветственный /start с ПРЕМИУМ-эмодзи (aiogram 3.x).

ВАЖНО (по официальной документации Telegram Bot API):
  • Синтаксис премиум-эмодзи:  <tg-emoji emoji-id="CUSTOM_EMOJI_ID">фолбэк</tg-emoji>
    Атрибут называется emoji-id (не id) — https://core.telegram.org/bots/api#html-style
  • Кастом-эмодзи отрисовываются в сообщении ТОЛЬКО если оно отправлено
    «как премиум»: через business_connection_id (премиум-аккаунт-посредник,
    Telegram Business → Чат-боты) или ботом с Fragment-username.
    Иначе Telegram покажет обычный эмодзи-фолбэк изнутри тега — ошибки не будет.
  • В ТЕКСТЕ ИНЛАЙН-КНОПОК Telegram НЕ рендерит кастом-эмодзи (Bot API
    передаёт только plain text) — в кнопках остаётся Unicode-эмодзи.
  • Всё сообщение отправляется с parse_mode="HTML" (DefaultBotProperties).
"""

import asyncio
import logging

from aiogram import Bot, Dispatcher, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.filters import CommandStart
from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
)

BOT_TOKEN = "PASTE_BOT_TOKEN_HERE"

# Кнопка «Открыть» ведёт в мини-апп, а не на сайт
TME_APP_URL = "https://t.me/tgswipe_bot/tgswipe"
CHANNEL_URL = "https://t.me/SnapTeamDev"

# ── Библиотека премиум-эмодзи (custom_emoji_id) ─────────────────────────
EMOJI = {
    "fire": "5432110534282151111",      # 🔥 Fire animated (огонь)
    "star": "5432110534282152222",      # ⭐ Blue Star (синяя звезда)
    "rocket": "5433890253483321901",    # 🚀 Rocket (ракета)
    "notebook": "5456140674028019486",  # 📖 Notebook (книга/блокнот)
    "thumbsup": "5432110534282153333",  # 👍 Thumbs up (палец вверх)
    "alert": "5456140674028019123",     # ⚠️ Alert (восклицательный знак)
    "lightning": "5432110534282154444", # ⚡ Lightning (молния)
    "wave": "5432110534282155555",      # 👋 Waving hand (машущая рука)
}


def premium(emoji_id: str, fallback: str) -> str:
    """Обернуть эмодзи в <tg-emoji> с обязательным юникод-фолбэком."""
    return f'<tg-emoji emoji-id="{emoji_id}">{fallback}</tg-emoji>'


# ── Сообщение /start: обычные эмодзи → премиальные аналоги ──────────────
WELCOME_TEXT = (
    f"{premium(EMOJI['wave'], '👋')} <b>Привет!</b> Это умная лента.\n"
    f"{premium(EMOJI['lightning'], '⚡')} Свайпай по интересам.\n"
    f"{premium(EMOJI['notebook'], '📖')} Читай каналы без подписок.\n"
    f"{premium(EMOJI['rocket'], '🚀')} Продвигай свой канал в топ."
)

# В кнопках — только Unicode (Telegram Bot API не рендерит tg-emoji в кнопках)
START_KEYBOARD = InlineKeyboardMarkup(
    inline_keyboard=[
        [InlineKeyboardButton(text="✨ Подписаться на Telegram", url=CHANNEL_URL)],
        [InlineKeyboardButton(text="📖 Открыть Swipe", url=TME_APP_URL)],
    ]
)

router = Router()


@router.message(CommandStart())
async def cmd_start(message: Message) -> None:
    # parse_mode="HTML" задан через DefaultBotProperties — передавать не нужно
    await message.answer(WELCOME_TEXT, reply_markup=START_KEYBOARD)


async def main() -> None:
    logging.basicConfig(level=logging.INFO)
    bot = Bot(token=BOT_TOKEN, default=DefaultBotProperties(parse_mode="HTML"))
    dp = Dispatcher()
    dp.include_router(router)

    # long polling: вебхук не нужен (для прод-версии бота см. setWebhook)
    await bot.delete_webhook(drop_pending_updates=True)
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
