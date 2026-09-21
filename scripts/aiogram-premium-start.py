"""
Tg Swipe — приветственный /start с ПРЕМИУМ-эмодзи (aiogram 3.x).

ВАЖНО (по официальной документации Telegram Bot API, проверено 2025):
  • Синтаксис премиум-эмодзи:  <tg-emoji emoji-id="CUSTOM_EMOJI_ID">фолбэк</tg-emoji>
    Атрибут называется emoji-id (не id) — https://core.telegram.org/bots/api#html-style
  • КОГДА КАСТОМ-ЭМОДЗИ РЕНДЕРЯТСЯ (актуальные правила Bot API):
    1) если у ВЛАДЕЛЬЦА бота есть Telegram Premium — бот может слать кастом-эмодзи
       напрямую в личные чаты/группы/супергруппы (новое правило, бизнес не нужен);
    2) через business_connection_id (премиум-аккаунт-посредник,
       Telegram Business → Чат-боты) — но НЕ «самому себе» (владельцу
       анимация через посредника не придёт: Telegram запрещает self-send);
    3) если у бота Fragment-username.
    Иначе Telegram покажет обычный эмодзи-фолбэк изнутри тега — ошибки не будет.
  • ГДЕ БРАТЬ custom_emoji_id: юзер отправляет боту сообщение с премиум-эмодзи →
    Telegram передаёт entities с type='custom_emoji' и полем custom_emoji_id
    (см. хендлер ниже). Расшифровать ID → getCustomEmojiStickers.
  • В обычных инлайн-кнопках (InlineKeyboardButton) кастом-эмодзи НЕ рендерятся —
    там Unicode. НО новый метод sendRichMessage (rich HTML) умеет и стили кнопок
    (<tg-button style="success|link|danger|primary">), и <tg-emoji> внутри кнопки.
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
# ВНИМАНИЕ: проверено getCustomEmojiStickers — из присланного списка валиден
# ТОЛЬКО notebook; остальные Telegram НЕ знает (sendMessage → DOCUMENT_INVALID).
# Реальные ID: юзер шлёт боту премиум-эмодзи → entities custom_emoji → ID.
EMOJI = {
    "notebook": "5456140674028019486",  # 📖 Notebook — ЕДИНСТВЕННЫЙ валидный
}


def premium(emoji_id: str, fallback: str) -> str:
    """Обернуть эмодзи в <tg-emoji> с обязательным юникод-фолбэком."""
    return f'<tg-emoji emoji-id="{emoji_id}">{fallback}</tg-emoji>'


# ── Сообщение /start: премиум только для ВАЛИДИРОВАННЫХ ID ──────────────
# Невалидный ID в <tg-emoji> ломает ВСЁ сообщение (Bad Request:
# DOCUMENT_INVALID) — эмодзи без проверенного ID остаются юникодом.
WELCOME_TEXT = (
    f"👋 <b>Привет!</b> Это умная лента.\n"
    f"⚡ Свайпай по интересам.\n"
    f"{premium(EMOJI['notebook'], '📖')} Читай каналы без подписок.\n"
    f"🚀 Продвигай свой канал в топ."
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


@router.message(lambda m: m.entities or m.caption_entities)
async def capture_custom_emoji(message: Message) -> None:
    """ЗАХВАТ custom_emoji_id: юзер прислал премиум-эмодзи → бот узнаёт ID.

    Telegram передаёт entity типа custom_emoji с полем custom_emoji_id;
    сам юникод-эмодзи лежит в тексте по offset/length (UTF-16 code units).
    """
    found = []
    for text, entities in (
        (message.text, message.entities),
        (message.caption, message.caption_entities),
    ):
        if not text or not entities:
            continue
        for e in entities:
            if e.type == "custom_emoji" and e.custom_emoji_id:
                emoji = text[e.offset: e.offset + e.length]
                found.append((emoji, e.custom_emoji_id))
    if not found:
        return
    lines = "\n".join(f"{emoji} → <code>{eid}</code>" for emoji, eid in dict(found).items())
    await message.answer(
        f"📌 Захвачен custom_emoji_id:\n{lines}\n\n"
        f"Расшифровка: getCustomEmojiStickers([ID]) — вернёт пак, анимацию и эмодзи."
    )


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
