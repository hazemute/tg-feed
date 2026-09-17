'use client'

import { useState, type FormEvent } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { PanelError, panelFetch, setAdminKey, type LoginResponse } from './api'
import { inputDark, panelCard } from './bits'

export function LoginScreen({ onSuccess }: { onSuccess: (version: string) => void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [doneVersion, setDoneVersion] = useState<string | null>(null)

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    const trimmed = key.trim()
    if (busy || !trimmed) return
    setBusy(true)
    setError(null)
    try {
      const res = await panelFetch<LoginResponse>('/api/panel/login', { json: { key: trimmed } })
      setAdminKey(trimmed)
      setDoneVersion(res.version || '')
      // Короткая пауза — показать «Вход выполнен» в футере карточки, затем дашборд.
      setTimeout(() => onSuccess(res.version || ''), 700)
    } catch (err) {
      setBusy(false)
      if (err instanceof PanelError) {
        if (err.status === 401) setError('Неверный ключ')
        else if (err.status === 501) setError('ADMIN_KEY не задан в .env')
        else if (err.status !== 0) setError(err.message)
      } else {
        setError('Не удалось войти')
      }
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className={`w-full max-w-sm ${panelCard}`}>
        <CardHeader className="items-center text-center">
          <img src="/logo.svg" alt="" className="mx-auto h-10 w-10" />
          <CardTitle className="text-lg font-semibold text-slate-100">Tg Swipe · Админ</CardTitle>
          <CardDescription className="text-sm text-slate-400">
            Локальная панель управления · доступ по ключу
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-3" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="admin-key" className="text-xs text-slate-400">
                Ключ администратора
              </Label>
              <Input
                id="admin-key"
                type="password"
                autoFocus
                autoComplete="current-password"
                placeholder="ADMIN_KEY"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                disabled={busy || doneVersion !== null}
                className={inputDark}
                aria-invalid={error ? true : undefined}
              />
            </div>
            {error ? (
              <p role="alert" className="text-sm text-red-400">
                {error}
              </p>
            ) : null}
            <Button
              type="submit"
              disabled={busy || !key.trim() || doneVersion !== null}
              className="w-full bg-emerald-500 font-medium text-slate-950 hover:bg-emerald-400"
            >
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <KeyRound aria-hidden />}
              Войти
            </Button>
          </form>
        </CardContent>
        <CardFooter className="justify-center">
          {doneVersion !== null ? (
            <p className="text-xs text-emerald-300">
              Вход выполнен{doneVersion ? ` · API v${doneVersion}` : ''}
            </p>
          ) : (
            <p className="text-center text-xs text-slate-500">
              Ключ задаётся переменной ADMIN_KEY в .env
            </p>
          )}
        </CardFooter>
      </Card>
    </div>
  )
}
