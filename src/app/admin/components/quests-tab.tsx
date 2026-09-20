'use client'

/**
 * Вкладка «Задания» (v5.51): награды за подписку на канал / вступление в чат.
 *  - CRUD заданий с ВАЛИДАЦИЕЙ цели (getChat + бот-админ) до публикации;
 *  - статистика по каждому заданию: выполнено / аннулировано (отписался);
 *  - включение/выключение и удаление.
 * Умная защита на сервере: отписался → аннулирование + штраф ×2 (lib/quests.ts).
 */

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  AlertTriangle,
  BadgeCheck,
  ListChecks,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

import { isAuthOrNetworkError, PanelError, panelFetch } from './api'
import { EmptyState, fadeUp, inputDark, SkeletonRows, TabProps } from './bits'

type PanelQuest = {
  id: string
  title: string
  description: string | null
  kind: string
  target: string
  link: string
  rewardSwp: number
  active: boolean
  sort: number
  createdAt: string
  doneCount: number
  revokedCount: number
  completionsTotal: number
}

type Validation = {
  ok: boolean
  target: string | null
  title?: string
  members?: number | null
  verificationProblem?: string | null
}

const KIND_OPTIONS = [
  { value: 'subscribe', label: '📢 Подписка на канал' },
  { value: 'join_chat', label: '💬 Вступление в чат' },
]

const EMPTY_FORM = {
  title: '',
  description: '',
  kind: 'subscribe',
  target: '',
  link: '',
  rewardSwp: 100,
  sort: 0,
}

export function QuestsTab({ tick, onSettled }: TabProps) {
  const [items, setItems] = useState<PanelQuest[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Форма создания/правки
  const [form, setForm] = useState<typeof EMPTY_FORM & { id?: string }>({ ...EMPTY_FORM })
  const [formOpen, setFormOpen] = useState(false)
  const [validation, setValidation] = useState<Validation | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const r = await panelFetch<{ items: PanelQuest[] }>('/api/panel/quests', { timeoutMs: 15_000 })
      setItems(r.items)
    } catch (e) {
      if (!isAuthOrNetworkError(e)) {
        setError(e instanceof PanelError ? e.message : 'Не удалось загрузить задания')
      }
    } finally {
      onSettled()
    }
  }, [onSettled])

  useEffect(() => {
    void load()
  }, [load, tick])

  const act = async (json: Record<string, unknown>, okMsg: string) => {
    if (busy) return
    setBusy(true)
    try {
      await panelFetch('/api/panel/quests', { json, timeoutMs: 20_000 })
      toast.success(okMsg)
      await load()
    } catch (e) {
      if (!isAuthOrNetworkError(e)) {
        toast.error(e instanceof PanelError ? e.message : 'Ошибка операции')
      }
    } finally {
      setBusy(false)
    }
  }

  const checkTarget = async () => {
    if (!form.target.trim()) {
      toast.error('Введите @username цели')
      return
    }
    setBusy(true)
    setValidation(null)
    try {
      const r = await panelFetch<{ validation: Validation }>('/api/panel/quests', {
        json: { action: 'check', target: form.target },
        timeoutMs: 20_000,
      })
      setValidation(r.validation)
    } catch (e) {
      if (!isAuthOrNetworkError(e)) toast.error('Не удалось проверить цель')
    } finally {
      setBusy(false)
    }
  }

  const submitForm = async () => {
    if (!form.title.trim() || form.title.trim().length < 3) {
      toast.error('Название: минимум 3 символа')
      return
    }
    if (!form.target.trim()) {
      toast.error('Укажите цель — @username канала или чата')
      return
    }
    setBusy(true)
    try {
      const r = await panelFetch<{ ok: boolean; validation?: Validation }>('/api/panel/quests', {
        json: {
          action: form.id ? 'update' : 'create',
          id: form.id,
          title: form.title.trim(),
          description: form.description.trim() || null,
          kind: form.kind,
          target: form.target.trim(),
          link: form.link.trim() || null,
          rewardSwp: Math.max(1, Math.round(Number(form.rewardSwp) || 0)),
          sort: Math.max(0, Math.round(Number(form.sort) || 0)),
        },
        timeoutMs: 25_000,
      })
      const problem = r.validation?.verificationProblem
      if (problem) toast.warning(`Сохранено, но: ${problem}`)
      else toast.success(form.id ? 'Задание обновлено' : 'Задание создано')
      setFormOpen(false)
      setForm({ ...EMPTY_FORM })
      setValidation(null)
      await load()
    } catch (e) {
      if (!isAuthOrNetworkError(e)) {
        toast.error(e instanceof PanelError ? e.message : 'Ошибка сохранения')
      }
    } finally {
      setBusy(false)
    }
  }

  const startEdit = (q: PanelQuest) => {
    setForm({
      id: q.id,
      title: q.title,
      description: q.description ?? '',
      kind: q.kind,
      target: q.target,
      link: q.link.startsWith('https://t.me/') ? '' : q.link,
      rewardSwp: q.rewardSwp,
      sort: q.sort,
    })
    setValidation(null)
    setFormOpen(true)
  }

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show" className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
            <ListChecks className="size-5 text-emerald-600" aria-hidden />
            Задания с наградой
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Подписка/вступление за свайпы · проверка Bot API · отписался → аннулирование + штраф ×2
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            className="border-slate-300 text-slate-700 hover:bg-slate-100"
            aria-label="Обновить список заданий"
          >
            <RefreshCw className={cn('size-4', !items && 'animate-spin')} aria-hidden />
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setForm({ ...EMPTY_FORM })
              setValidation(null)
              setFormOpen((o) => !o)
            }}
            className="bg-emerald-600 text-white hover:bg-emerald-700"
          >
            <Plus className="size-4" aria-hidden />
            Создать
          </Button>
        </div>
      </div>

      {/* Форма создания/правки */}
      {formOpen && (
        <motion.section
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-xl border border-slate-200 bg-white p-4"
        >
          <h3 className="text-sm font-semibold text-slate-900">
            {form.id ? 'Правка задания' : 'Новое задание'}
          </h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="q-title" className="text-xs text-slate-600">
                Название (что увидит юзер)
              </Label>
              <Input
                id="q-title"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="Подпишись на @SnapTeamDev"
                className={inputDark}
                maxLength={120}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="q-kind" className="text-xs text-slate-600">
                Тип задания
              </Label>
              <select
                id="q-kind"
                value={form.kind}
                onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
                className="h-9 w-full rounded-md border border-slate-200 bg-slate-100 px-3 text-sm text-slate-800"
              >
                {KIND_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="q-target" className="text-xs text-slate-600">
                Цель — @username канала/чата
              </Label>
              <div className="flex gap-2">
                <Input
                  id="q-target"
                  value={form.target}
                  onChange={(e) => setForm((f) => ({ ...f, target: e.target.value }))}
                  placeholder="@durov или https://t.me/durov"
                  className={cn(inputDark, 'font-mono')}
                  maxLength={120}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void checkTarget()}
                  disabled={busy}
                  className="shrink-0 border-slate-300 text-slate-700 hover:bg-slate-100"
                >
                  Проверить
                </Button>
              </div>
              {validation && (
                <div
                  className={cn(
                    'rounded-md px-2.5 py-1.5 text-[11.5px] leading-snug',
                    !validation.ok
                      ? 'bg-red-50 text-red-700'
                      : validation.verificationProblem
                        ? 'bg-amber-50 text-amber-700'
                        : 'bg-emerald-50 text-emerald-700',
                  )}
                >
                  {!validation.ok ? (
                    validation.verificationProblem ?? 'Цель не найдена'
                  ) : validation.verificationProblem ? (
                    <span className="flex items-start gap-1.5">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      {validation.title ? `«${validation.title}» — ` : ''}
                      {validation.verificationProblem}
                    </span>
                  ) : (
                    <span className="flex items-start gap-1.5">
                      <BadgeCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      {validation.title ? `«${validation.title}»` : 'Цель найдена'} — бот в цели,
                      проверка работает
                      {validation.members ? ` · ${validation.members.toLocaleString('ru')} подписчиков` : ''}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="q-reward" className="text-xs text-slate-600">
                Награда, свайпов
              </Label>
              <Input
                id="q-reward"
                type="number"
                min={1}
                max={1_000_000}
                value={form.rewardSwp}
                onChange={(e) => setForm((f) => ({ ...f, rewardSwp: Number(e.target.value) }))}
                className={inputDark}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="q-desc" className="text-xs text-slate-600">
                Описание (необязательно)
              </Label>
              <Input
                id="q-desc"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Свежие посты о технологиях каждый день"
                className={inputDark}
                maxLength={300}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="q-link" className="text-xs text-slate-600">
                Своя ссылка-кнопка (необязательно)
              </Label>
              <Input
                id="q-link"
                value={form.link}
                onChange={(e) => setForm((f) => ({ ...f, link: e.target.value }))}
                placeholder="по умолчанию https://t.me/<цель>"
                className={cn(inputDark, 'font-mono')}
                maxLength={300}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="q-sort" className="text-xs text-slate-600">
                Порядок сортировки (меньше — выше)
              </Label>
              <Input
                id="q-sort"
                type="number"
                min={0}
                max={9999}
                value={form.sort}
                onChange={(e) => setForm((f) => ({ ...f, sort: Number(e.target.value) }))}
                className={inputDark}
              />
            </div>
          </div>
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFormOpen(false)
                setForm({ ...EMPTY_FORM })
                setValidation(null)
              }}
              className="text-slate-600 hover:bg-slate-100"
            >
              Отмена
            </Button>
            <Button
              size="sm"
              onClick={() => void submitForm()}
              disabled={busy}
              className="bg-emerald-600 text-white hover:bg-emerald-700"
            >
              {form.id ? 'Сохранить' : 'Создать задание'}
            </Button>
          </div>
        </motion.section>
      )}

      {/* Список заданий */}
      {error ? (
        <EmptyState icon={AlertTriangle} title="Не удалось загрузить" hint={error} />
      ) : !items ? (
        <SkeletonRows rows={5} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="Заданий ещё нет"
          hint="Создайте первое задание — юзеры увидят его во вкладке «Задания» и получат свайпы за подписку."
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2 font-medium">Задание</th>
                <th className="px-3 py-2 font-medium">Награда</th>
                <th className="hidden px-3 py-2 text-center font-medium sm:table-cell">Выполнено</th>
                <th className="hidden px-3 py-2 text-center font-medium sm:table-cell">
                  Аннулировано
                </th>
                <th className="px-3 py-2 text-center font-medium">Вкл</th>
                <th className="px-3 py-2 text-right font-medium">Действия</th>
              </tr>
            </thead>
            <tbody>
              {items.map((q) => (
                <tr
                  key={q.id}
                  className={cn(
                    'border-b border-slate-100 transition last:border-0 hover:bg-slate-50/70',
                    !q.active && 'opacity-55',
                  )}
                >
                  <td className="max-w-[280px] px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span aria-hidden>{q.kind === 'join_chat' ? '💬' : '📢'}</span>
                      <div className="min-w-0">
                        <div className="truncate font-medium text-slate-900">{q.title}</div>
                        <div className="truncate font-mono text-[11px] text-slate-500">@{q.target}</div>
                      </div>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 font-semibold text-emerald-700 tabular-nums">
                    +{q.rewardSwp.toLocaleString('ru')}
                  </td>
                  <td className="hidden px-3 py-2.5 text-center tabular-nums text-slate-700 sm:table-cell">
                    {q.doneCount}
                  </td>
                  <td className="hidden px-3 py-2.5 text-center tabular-nums text-slate-700 sm:table-cell">
                    {q.revokedCount > 0 ? (
                      <span className="font-semibold text-red-600">{q.revokedCount}</span>
                    ) : (
                      '0'
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <Switch
                      checked={q.active}
                      onCheckedChange={() =>
                        void act({ action: 'toggle', id: q.id }, q.active ? 'Задание выключено' : 'Задание включено')
                      }
                      disabled={busy}
                      aria-label={`Включённость задания «${q.title}»`}
                      className="data-[state=checked]:bg-emerald-600"
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => startEdit(q)}
                        className="h-8 px-2 text-slate-600 hover:bg-slate-100"
                        aria-label={`Редактировать задание «${q.title}»`}
                      >
                        <Pencil className="size-3.5" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (!window.confirm(`Удалить задание «${q.title}»? Выполнения тоже удалятся.`)) return
                          void act({ action: 'delete', id: q.id }, 'Задание удалено')
                        }}
                        className="h-8 px-2 text-red-600 hover:bg-red-50 hover:text-red-700"
                        aria-label={`Удалить задание «${q.title}»`}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </motion.div>
  )
}
