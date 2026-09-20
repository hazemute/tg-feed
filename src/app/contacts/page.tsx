import type { Metadata } from 'next'
import { H2, LegalShell, LI, Note, P } from '@/components/legal/LegalShell'

export const metadata: Metadata = {
  title: 'Поддержка и контакты — Tg Swipe',
  description:
    'Контакты поддержки Tg Swipe: чат поддержки в приложении (ИИ-ассистент 24/7 и живой сотрудник), бот @tgswipe_bot, канал новостей @SnapTeamDev. Контакты для банков, платёжных провайдеров и партнёров.',
}

/**
 * Поддержка и контакты (v5.43) — требование платёжного провайдера: контакты
 * поддержки должны быть в виде тикет-системы/юзернейма/почты (группа не подходит).
 *
 * E-mail подставляется из env SUPPORT_EMAIL, если задан (в Vercel). Юзернеймы:
 * бот @tgswipe_bot (вход/поддержка), канал @SnapTeamDev (новости проекта).
 */
export default function ContactsPage() {
  const email = process.env.SUPPORT_EMAIL?.trim() ?? ''

  return (
    <LegalShell
      title="Поддержка и контакты"
      subtitle="Как быстро получить помощь и связаться с командой Tg Swipe"
    >
      <Note>
        Поддержка отвечает в тикет-системе внутри приложения и в боте. Среднее время ответа — до
        24 часов; ИИ-ассистент отвечает мгновенно и круглосуточно.
      </Note>

      <H2>1. Тикет-система в приложении</H2>
      <P>
        Внутри миниаппа: <b>Профиль → Обратная связь → Поддержка</b>. Сначала отвечает
        ИИ-ассистент (знает все функции приложения, доступен 24/7), при необходимости диалог
        передаётся живому сотруднику — переписка продолжается в том же чате, ответ приходит
        уведомлением.
      </P>

      <H2>2. Telegram-контакты</H2>
      <ul className="mt-2 list-none pl-0">
        <LI>
          бот{' '}
          <a
            href="https://t.me/tgswipe_bot"
            target="_blank"
            rel="noopener noreferrer"
            className="text-emerald-300 hover:underline"
          >
            @tgswipe_bot
          </a>{' '}
          — вход в приложение, поддержка, оплата тарифов, уведомления и розыгрыши;
        </LI>
        <LI>
          канал{' '}
          <a
            href="https://t.me/SnapTeamDev"
            target="_blank"
            rel="noopener noreferrer"
            className="text-emerald-300 hover:underline"
          >
            @SnapTeamDev
          </a>{' '}
          — новости и обновления сервиса;
        </LI>
        {email ? (
          <LI>
            почта:{' '}
            <a href={`mailto:${email}`} className="text-emerald-300 hover:underline">
              {email}
            </a>
          </LI>
        ) : null}
      </ul>

      <H2>3. Типовые обращения</H2>
      <ul className="mt-2 list-none pl-0">
        <LI>не зачислился платёж или баланс — поддержка, приложите сумму и время платежа;</LI>
        <LI>вопрос о свайпах, тарифах или рекламе — поддержка или ИИ-ассистент;</LI>
        <LI>жалоба на контент / скрытие своего канала из ленты — поддержка (вопрос к сотруднику);</LI>
        <LI>удаление аккаунта и данных — поддержка, обработка по Политике конфиденциальности.</LI>
      </ul>

      <H2>4. Для банков, платёжных провайдеров и партнёров</H2>
      <P>
        Проект Tg Swipe — сервис умной ленты публичных Telegram-каналов (сайт
        tg-swipe.vercel.app, Telegram Mini App). По вопросам сотрудничества и эквайринга —
        бот @tgswipe_bot с пометкой «сотрудничество»{email ? ` или почта ${email}` : ''}.
      </P>
      <P>
        Правовые документы сервиса:{' '}
        <a href="/terms" className="text-emerald-300 hover:underline">
          Пользовательское соглашение
        </a>
        ,{' '}
        <a href="/privacy" className="text-emerald-300 hover:underline">
          Политика конфиденциальности
        </a>
        ,{' '}
        <a href="/pricing" className="text-emerald-300 hover:underline">
          Тарифы и цены
        </a>
        .
      </P>
    </LegalShell>
  )
}
