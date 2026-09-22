'use client'

/**
 * v5.89 — глобальный error boundary для /admin: ловит падения САМОГО layout'а
 * (когда app/error.tsx уже не рендерится — он живёт внутри layout).
 * Обязан рендерить собственные <html>/<body>. Тоже гасит boot-шторку.
 */

import { useEffect } from 'react'

import { hideBootShell } from '@/lib/boot-shell'

export default function AdminGlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    hideBootShell()
    console.error('[admin] global render error:', error)
  }, [error])

  return (
    <html lang="ru">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          background: '#f8fafc',
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
          padding: 24,
          textAlign: 'center',
        }}
      >
        <div>
          <p style={{ fontSize: 16, fontWeight: 600, color: '#0f172a' }}>
            Панель не загрузилась
          </p>
          <p style={{ fontSize: 14, color: '#64748b', marginTop: 4 }}>
            Критическая ошибка интерфейса. Попробуйте перезагрузить страницу.
          </p>
          {error?.digest && (
            <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 8, fontFamily: 'monospace' }}>
              digest: {error.digest}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={reset}
          style={{
            minHeight: 44,
            padding: '0 26px',
            border: 'none',
            borderRadius: 999,
            fontSize: 15,
            fontWeight: 600,
            color: '#fff',
            cursor: 'pointer',
            background: '#10b981',
          }}
        >
          Перезагрузить
        </button>
      </body>
    </html>
  )
}
