'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Copy,
  Gem,
  KeyRound,
  Loader2,
  Plus,
  Power,
  Sparkles,
  Ticket,
  Trash2,
  Wallet,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { panelFetch, PanelError } from './api'
import { BoolBadge, SkeletonRows, btnOutlineDark, fadeUp, inputDark, panelCard } from './bits'
import { cn } from '@/lib/utils'

/**
 * «Промокоды» (v5.65) — генератор наградных кодов в админ-панели.
 *
 * Конструктор: тип награды (Свайпы / Рубли / Snap Pro) + размер/срок +
 * лимит активаций + срок жизни. Код можно ввести свой или сгенерировать
 * автоматически (формат XXX-XXX-XXX, без похожих символов).
 *
 * Активация: пользователь в миниаппе (кошелёк) вводит код — награда
 * начисляется мгновенно (POST /api/promo/redeem).
 */

type PromoKind = 'swipes' | 'rub' | 'tier'

type PromoRow = {
  id: string
  code: string
  kind: PromoKind
  swipes: number
  amountKop: number
  tierPlan: string | null
  tierDays: number
  maxUses: number
  usedCount: number
  active: boolean
  note: string | null
  expiresAt: string | null
  createdAt: string
  recent: Array<{ userId: string; reward: string; createdAt: string }>
}

const fmtKop = (kop: number): string => `${(kop / 100).toLocaleString('ru-RU')} ₽`

function rewardOf(c: PromoRow): string {
  if (c.kind === 'swipes') return `${c.swipes.toLocaleString('ru-RU')} свайпов`
  if (c.kind === 'rub') return fmtKop(c.amountKop)
  return `Snap ${c.tierPlan === 'pro' ? 'Pro' : 'Plus'} · ${c.tierDays} дн.`
}

const KIND_ICON: Record<PromoKind, typeof Wallet> = {
  swipes: Sparkles,
  rub: Wallet,
  tier: Gem,
}

export function PromosTab({ onSettled }: { onSettled?: () => void }) {
  const [codes, setCodes] = useState<PromoRow[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)

  // Форма генератора
  const [kind, setKind] = useState<PromoKind>('swipes')
  const [customCode, setCustomCode] = useState('')
  const [swipes, setSwipes] = useState('1000')
  const [amountRub, setAmountRub] = useState('100')
  const [tierPlan, setTierPlan] = useState<'plus' | 'pro'>('pro')
  const [tierDays, setTierDays] = useState('7')
  const [maxUses, setMaxUses] = useState('100')
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await panelFetch<{ codes: PromoRow[] }>('/api/panel/promocodes')
      setCodes(r.codes)
      onSettled?.()
    } catch (e) {
      if (!(e instanceof PanelError && e.status === 401)) {
        toast.error('Не удалось загрузить промокоды')
        setCodes([])
      }
    }
  }, [onSettled])

  useEffect(() => {
    void load()
  }, [load])

  const create = useCallback(async () => {
    if (creating) return
    setCreating(true)
    try {
      const body: Record<string, unknown> = {
        kind,
        maxUses: Math.max(1, Math.round(Number(maxUses) || 1)),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(customCode.trim() ? { code: customCode.trim().toUpperCase() } : {}),
      }
      if (kind === 'swipes') body.swipes = Math.max(1, Math.round(Number(swipes) || 0))
      if (kind === 'rub') body.amountRub = Math.max(1, Number(amountRub) || 0)
      if (kind === 'tier') {
        body.tierPlan = tierPlan
        body.tierDays = Math.max(1, Math.round(Number(tierDays) || 1))
      }
      const r = await panelFetch<{ ok: true; code: PromoRow }>('/api/panel/promocodes', { json: body })
      toast.success(`Код ${r.code.code} создан`)
      setCustomCode('')
      setNote('')
      setCodes((prev) => [r.code, ...(prev ?? [])])
      onSettled?.()
    } catch (e) {
      if (e instanceof PanelError) toast.error(e.message)
    } finally {
      setCreating(false)
    }
  }, [amountRub, creating, customCode, kind, maxUses, note, onSettled, swipes, tierDays, tierPlan])

  const toggle = useCallback(
    async (c: PromoRow) => {
      setBusy(true)
      try {
        await panelFetch('/api/panel/promocodes', {
          method: 'PATCH',
          json: { id: c.id, active: !c.active },
        })
        setCodes((prev) => prev?.map((x) => (x.id === c.id ? { ...x, active: !c.active } : x)) ?? null)
        onSettled?.()
      } catch (e) {
        if (e instanceof PanelError) toast.error(e.message)
      } finally {
        setBusy(false)
      }
    },
    [onSettled],
  )

  const remove = useCallback(
    async (c: PromoRow) => {
      if (!window.confirm(`Удалить код ${c.code}? Активации тоже будут удалены.`)) return
      setBusy(true)
      try {
        await panelFetch('/api/panel/promocodes', { method: 'DELETE', json: { id: c.id } })
        setCodes((prev) => prev?.filter((x) => x.id !== c.id) ?? null)
        toast.success('Код удалён')
        onSettled?.()
      } catch (e) {
        if (e instanceof PanelError) toast.error(e.message)
      } finally {
        setBusy(false)
      }
    },
    [onSettled],
  )

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="visible" className="space-y-5">
      {/* ------------------------- Генератор ------------------------- */}
      <Card className={panelCard}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Ticket className="h-5 w-5 text-violet-500" aria-hidden /> Генератор промокодов
          </CardTitle>
          <CardDescription>
            Создайте код с наградой: пользователь активирует его в кошельке миниаппа и получает бонус мгновенно.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Тип награды</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as PromoKind)}>
                <SelectTrigger className="w-full" aria-label="Тип награды">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="swipes">
                    <span className="flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-amber-500" aria-hidden /> Свайпы (валюта ИИ)
                    </span>
                  </SelectItem>
                  <SelectItem value="rub">
                    <span className="flex items-center gap-2">
                      <Wallet className="h-4 w-4 text-emerald-500" aria-hidden /> Рубли (реальный баланс)
                    </span>
                  </SelectItem>
                  <SelectItem value="tier">
                    <span className="flex items-center gap-2">
                      <Gem className="h-4 w-4 text-violet-500" aria-hidden /> Snap Pro / Plus на срок
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {kind === 'swipes' && (
              <div className="space-y-1.5">
                <Label htmlFor="promo-swipes">Свайпов на баланс</Label>
                <Input
                  id="promo-swipes"
                  type="number"
                  min={1}
                  value={swipes}
                  onChange={(e) => setSwipes(e.target.value)}
                  className={inputDark}
                  placeholder="1000"
                />
              </div>
            )}
            {kind === 'rub' && (
              <div className="space-y-1.5">
                <Label htmlFor="promo-rub">Рублей на баланс</Label>
                <Input
                  id="promo-rub"
                  type="number"
                  min={1}
                  value={amountRub}
                  onChange={(e) => setAmountRub(e.target.value)}
                  className={inputDark}
                  placeholder="100"
                />
              </div>
            )}
            {kind === 'tier' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Тариф</Label>
                  <Select value={tierPlan} onValueChange={(v) => setTierPlan(v as 'plus' | 'pro')}>
                    <SelectTrigger className="w-full" aria-label="Тариф">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pro">Snap Pro</SelectItem>
                      <SelectItem value="plus">Snap Plus</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="promo-days">Дней</Label>
                  <Input
                    id="promo-days"
                    type="number"
                    min={1}
                    value={tierDays}
                    onChange={(e) => setTierDays(e.target.value)}
                    className={inputDark}
                    placeholder="7"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="promo-code">Код (необязательно — сгенерируем сами)</Label>
              <div className="flex gap-2">
                <Input
                  id="promo-code"
                  value={customCode}
                  onChange={(e) => setCustomCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
                  className={cn(inputDark, 'font-mono tracking-wider')}
                  placeholder="SPRING-2026"
                />
                <Button
                  type="button"
                  variant="outline"
                  className={btnOutlineDark}
                  onClick={() => setCustomCode(randomCode())}
                  title="Сгенерировать случайный код"
                >
                  <KeyRound className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="promo-uses">Активаций максимум</Label>
              <Input
                id="promo-uses"
                type="number"
                min={1}
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
                className={inputDark}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="promo-note">Заметка (только для админов)</Label>
            <Input
              id="promo-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={inputDark}
              placeholder="Раздача в канале к релизу"
            />
          </div>

          <Button
            type="button"
            onClick={() => void create()}
            disabled={creating}
            className="w-full bg-violet-600 text-white hover:bg-violet-700 sm:w-auto"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
            Создать промокод
          </Button>
        </CardContent>
      </Card>

      {/* --------------------------- Список --------------------------- */}
      <Card className={panelCard}>
        <CardHeader>
          <CardTitle className="text-lg">Активные коды</CardTitle>
          <CardDescription>Награда начисляется пользователю мгновенно при активации в кошельке</CardDescription>
        </CardHeader>
        <CardContent>
          {codes === null ? (
            <SkeletonRows rows={4} />
          ) : codes.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">Промокодов пока нет — создайте первый выше.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Код</TableHead>
                  <TableHead>Награда</TableHead>
                  <TableHead className="hidden md:table-cell">Активации</TableHead>
                  <TableHead className="hidden lg:table-cell">Заметка</TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead className="w-[100px] text-right">Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {codes.map((c) => {
                  const Icon = KIND_ICON[c.kind] ?? Ticket
                  const exhausted = c.usedCount >= c.maxUses
                  return (
                    <TableRow key={c.id} className={cn(!c.active && 'opacity-55')}>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard.writeText(c.code)
                            toast.success('Код скопирован')
                          }}
                          className="group flex items-center gap-1.5 font-mono text-[13px] font-semibold tracking-wider text-slate-900"
                          title="Скопировать код"
                        >
                          {c.code}
                          <Copy className="h-3.5 w-3.5 opacity-40 transition group-hover:opacity-100" aria-hidden />
                        </button>
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-1.5 text-[13px] text-slate-700">
                          <Icon
                            className={cn(
                              'h-4 w-4',
                              c.kind === 'swipes' && 'text-amber-500',
                              c.kind === 'rub' && 'text-emerald-500',
                              c.kind === 'tier' && 'text-violet-500',
                            )}
                            aria-hidden
                          />
                          {rewardOf(c)}
                        </span>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <span className={cn('text-[13px]', exhausted ? 'font-semibold text-red-600' : 'text-slate-600')}>
                          {c.usedCount} / {c.maxUses}
                        </span>
                      </TableCell>
                      <TableCell className="hidden max-w-[220px] truncate text-[13px] text-slate-500 lg:table-cell">
                        {c.note ?? '—'}
                      </TableCell>
                      <TableCell>
                        {exhausted ? (
                          <BoolBadge value={false} falseText="исчерпан" />
                        ) : (
                          <BoolBadge value={c.active} trueText="активен" falseText="выключен" />
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => void toggle(c)}
                            disabled={busy}
                            title={c.active ? 'Выключить' : 'Включить'}
                            className="h-8 w-8 text-slate-500"
                          >
                            <Power className="h-4 w-4" aria-hidden />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => void remove(c)}
                            disabled={busy}
                            title="Удалить"
                            className="h-8 w-8 text-slate-400 hover:bg-red-50 hover:text-red-600"
                          >
                            <Trash2 className="h-4 w-4" aria-hidden />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </motion.div>
  )
}

/** Случайный код формата XXX-XXX-XXX (без похожих символов) */
function randomCode(): string {
  const AL = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const pick = (n: number): string =>
    Array.from({ length: n }, () => AL[Math.floor(Math.random() * AL.length)]).join('')
  return `${pick(3)}-${pick(3)}-${pick(3)}`
}
