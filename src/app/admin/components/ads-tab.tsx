'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  AlertTriangle,
  ExternalLink,
  Loader2,
  Megaphone,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

import {
  fmtAgo,
  fmtNum,
  isAuthOrNetworkError,
  panelFetch,
  PanelError,
  type Ad,
  type AdMutationResponse,
  type AdsResponse,
} from './api'
import {
  EmptyState,
  SkeletonRows,
  TabProps,
  btnOutlineDark,
  fadeUp,
  inputDark,
  panelCard,
  staggerContainer,
} from './bits'

const EMPTY_FORM: AdForm = {
  title: '',
  body: '',
  link: '',
  ctaLabel: 'Перейти',
  imageUrl: '',
}

interface AdForm {
  title: string
  body: string
  link: string
  ctaLabel: string
  imageUrl: string
}

function ActiveBadge({ isActive }: { isActive: boolean }) {
  return isActive ? (
    <Badge variant="outline" className="border border-emerald-500/30 bg-emerald-50 text-emerald-700">
      активна
    </Badge>
  ) : (
    <Badge variant="outline" className="border border-slate-200 bg-slate-100 text-slate-500">
      выключена
    </Badge>
  )
}

/** CTR строкой: «12.3%», для нулей — прочерк */
function ctr(clicks: number, impressions: number): string {
  if (impressions <= 0) return '—'
  return `${((clicks / impressions) * 100).toFixed(1)}%`
}

/** Метрики кампании: показы/клики/CTR за всё время и за 24 часа */
function AdMetrics({ ad }: { ad: Ad }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Metric label="Показы" value={fmtNum(ad.impressions)} sub={`за 24ч: ${fmtNum(ad.impressions24h)}`} />
      <Metric label="Клики" value={fmtNum(ad.clicks)} sub={`за 24ч: ${fmtNum(ad.clicks24h)}`} />
      <Metric label="CTR" value={ctr(ad.clicks, ad.impressions)} sub={`за 24ч: ${ctr(ad.clicks24h, ad.impressions24h)}`} />
      <Metric
        label="Статус"
        value={ad.isActive ? 'идёт показ' : 'пауза'}
        sub={ad.isActive ? 'ротация активна' : 'не показывается'}
      />
    </div>
  )
}

function Metric({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white px-2.5 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5 text-sm font-bold tabular-nums text-slate-800">{value}</div>
      <div className="text-[10px] tabular-nums text-slate-400">{sub}</div>
    </div>
  )
}

export function AdsTab({ tick, onSettled }: TabProps) {
  const [items, setItems] = useState<Ad[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [localTick, setLocalTick] = useState(0)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<AdForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    const run = async () => {
      try {
        const d = await panelFetch<AdsResponse>('/api/panel/ads')
        if (!alive) return
        setItems(d.items)
        setError(null)
        setLoading(false)
      } catch (e) {
        if (!alive || isAuthOrNetworkError(e)) return
        const msg = e instanceof PanelError ? e.message : 'Ошибка загрузки'
        if (items) toast.error(msg)
        else setError(msg)
        setLoading(false)
      } finally {
        if (alive) onSettled()
      }
    }
    void run()
    return () => {
      alive = false
    }
  }, [tick, localTick])

  const create = async () => {
    if (!form.title.trim() || !form.body.trim() || !form.link.trim()) return
    setSaving(true)
    try {
      const res = await panelFetch<AdMutationResponse>('/api/panel/ads', {
        json: {
          title: form.title.trim(),
          body: form.body.trim(),
          link: form.link.trim(),
          ctaLabel: form.ctaLabel.trim() || 'Перейти',
          imageUrl: form.imageUrl.trim() || undefined,
        },
      })
      setItems((prev) => (prev ? [res.ad, ...prev] : prev))
      toast.success('Реклама создана')
      setDialogOpen(false)
      setForm(EMPTY_FORM)
    } catch (e) {
      if (!isAuthOrNetworkError(e) && e instanceof PanelError) toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (ad: Ad, isActive: boolean) => {
    const snapshot = items
    setItems((prev) =>
      prev ? prev.map((i) => (i.id === ad.id ? { ...i, isActive } : i)) : prev,
    )
    try {
      const res = await panelFetch<AdMutationResponse>('/api/panel/ads', {
        method: 'PATCH',
        json: { id: ad.id, isActive },
      })
      setItems((prev) => (prev ? prev.map((i) => (i.id === ad.id ? res.ad : i)) : prev))
      toast.success(isActive ? 'Реклама активирована' : 'Реклама выключена')
    } catch (e) {
      setItems(snapshot)
      if (!isAuthOrNetworkError(e) && e instanceof PanelError) toast.error(e.message)
    }
  }

  const remove = async (ad: Ad) => {
    const snapshot = items
    setItems((prev) => (prev ? prev.filter((i) => i.id !== ad.id) : prev))
    try {
      await panelFetch(`/api/panel/ads?id=${encodeURIComponent(ad.id)}`, { method: 'DELETE' })
      toast.success(`«${ad.title}» удалена`)
    } catch (e) {
      setItems(snapshot)
      if (!isAuthOrNetworkError(e) && e instanceof PanelError) toast.error(e.message)
    }
  }

  const canSubmit = form.title.trim() !== '' && form.body.trim() !== '' && form.link.trim() !== ''

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show">
      <Card className={panelCard}>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base text-slate-900">Реклама</CardTitle>
              <CardDescription className="text-xs text-slate-500">
                Блоки рекламы в ленте мини-аппа
              </CardDescription>
            </div>
            <Button
              size="sm"
              onClick={() => setDialogOpen(true)}
              className="bg-emerald-500 font-medium text-slate-950 hover:bg-emerald-400"
            >
              <Plus aria-hidden /> Новая реклама
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading && items === null ? (
            <SkeletonRows rows={4} />
          ) : error && items === null ? (
            <EmptyState
              icon={AlertTriangle}
              title="Не удалось загрузить рекламу"
              hint={error}
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setLocalTick((t) => t + 1)}
                  className={btnOutlineDark}
                >
                  <RefreshCw aria-hidden /> Повторить
                </Button>
              }
            />
          ) : items && items.length === 0 ? (
            <EmptyState
              icon={Megaphone}
              title="Рекламы пока нет"
              hint="Создайте первый рекламный блок — он появится в ленте"
              action={
                <Button
                  size="sm"
                  onClick={() => setDialogOpen(true)}
                  className="bg-emerald-500 font-medium text-slate-950 hover:bg-emerald-400"
                >
                  <Plus aria-hidden /> Создать первую
                </Button>
              }
            />
          ) : items ? (
            <motion.div
              variants={staggerContainer}
              initial="hidden"
              animate="show"
              className="grid gap-3 lg:grid-cols-2"
            >
              {items.map((ad) => (
                <motion.div
                  key={ad.id}
                  variants={fadeUp}
                  whileHover={{ y: -2 }}
                  className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-slate-900">
                          {ad.title}
                        </span>
                        <ActiveBadge isActive={ad.isActive} />
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-snug text-slate-500">
                        {ad.body}
                      </p>
                    </div>
                    <Switch
                      checked={ad.isActive}
                      onCheckedChange={(v) => void toggle(ad, v)}
                      aria-label={`Активна: ${ad.title}`}
                      className="data-[state=checked]:bg-emerald-500"
                    />
                  </div>
                  <AdMetrics ad={ad} />
                  <div className="mt-auto flex items-center justify-between gap-2">
                    <a
                      href={ad.link}
                      target="_blank"
                      rel="noreferrer"
                      className="flex min-w-0 items-center gap-1 text-xs text-emerald-700 hover:text-emerald-200"
                    >
                      <ExternalLink className="size-3 shrink-0" aria-hidden />
                      <span className="truncate">
                        {ad.ctaLabel || 'Перейти'} → {ad.link}
                      </span>
                    </a>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-[11px] text-slate-500">{fmtAgo(ad.createdAt)}</span>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Удалить рекламу ${ad.title}`}
                            className="size-8 text-slate-500 hover:bg-red-50 hover:text-red-700"
                          >
                            <Trash2 className="size-4" aria-hidden />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent className="border-slate-200 bg-white text-slate-800">
                          <AlertDialogHeader>
                            <AlertDialogTitle className="text-slate-900">
                              Удалить рекламу?
                            </AlertDialogTitle>
                            <AlertDialogDescription className="text-slate-500">
                              Блок «{ad.title}» будет удалён без возможности восстановления.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel
                              className={cn(
                                'border-slate-200 bg-transparent text-slate-700 hover:bg-slate-100 hover:text-slate-900',
                              )}
                            >
                              Отмена
                            </AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => void remove(ad)}
                              className="bg-red-500/90 text-white hover:bg-red-500"
                            >
                              Удалить
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                </motion.div>
              ))}
            </motion.div>
          ) : null}
        </CardContent>
      </Card>

      {/* Диалог создания */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="border-slate-200 bg-white text-slate-800 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-slate-900">Новая реклама</DialogTitle>
            <DialogDescription className="text-slate-500">
              Появится в ленте как рекламный пост с кнопкой действия
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ad-title" className="text-xs text-slate-500">
                Заголовок *
              </Label>
              <Input
                id="ad-title"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                className={inputDark}
                placeholder="Например: Продвижение каналов"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ad-body" className="text-xs text-slate-500">
                Текст *
              </Label>
              <Textarea
                id="ad-body"
                value={form.body}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                className={cn('min-h-[80px]', inputDark)}
                placeholder="Текст рекламного блока"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ad-link" className="text-xs text-slate-500">
                Ссылка *
              </Label>
              <Input
                id="ad-link"
                value={form.link}
                onChange={(e) => setForm((f) => ({ ...f, link: e.target.value }))}
                className={inputDark}
                placeholder="https://t.me/..."
                inputMode="url"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ad-cta" className="text-xs text-slate-500">
                  Кнопка
                </Label>
                <Input
                  id="ad-cta"
                  value={form.ctaLabel}
                  onChange={(e) => setForm((f) => ({ ...f, ctaLabel: e.target.value }))}
                  className={inputDark}
                  placeholder="Перейти"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ad-image" className="text-xs text-slate-500">
                  Картинка (URL)
                </Label>
                <Input
                  id="ad-image"
                  value={form.imageUrl}
                  onChange={(e) => setForm((f) => ({ ...f, imageUrl: e.target.value }))}
                  className={inputDark}
                  placeholder="необязательно"
                  inputMode="url"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              className={cn('border-slate-200 bg-transparent text-slate-700 hover:bg-slate-100 hover:text-slate-900')}
            >
              Отмена
            </Button>
            <Button
              disabled={!canSubmit || saving}
              onClick={() => void create()}
              className="bg-emerald-500 font-medium text-slate-950 hover:bg-emerald-400"
            >
              {saving ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
              Создать
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  )
}
