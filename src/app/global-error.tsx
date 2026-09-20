'use client'

import { AlertTriangle, RotateCcw } from 'lucide-react'

/**
 * Глобальный error boundary последней инстанции (v5.57): рендерит
 * самостоятельный <html>/<body>, когда корневой layout не смог.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="ru">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#ffffff',
          color: '#0a0a0a',
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          padding: '0 24px',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: 96,
            height: 96,
            borderRadius: '50%',
            background: 'rgba(245, 158, 11, 0.12)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          aria-hidden
        >
          <AlertTriangle size={44} color="#f59e0b" strokeWidth={1.6} />
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginTop: 24 }}>
          Приложение не смогло запуститься
        </h1>
        <p style={{ fontSize: 14.5, lineHeight: 1.5, color: '#6b7280', maxWidth: 320 }}>
          Критическая ошибка. Попробуйте перезагрузить страницу — обычно это
          помогает.
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            marginTop: 32,
            minHeight: 44,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            borderRadius: 9999,
            background: '#2a9e63',
            color: '#fff',
            fontSize: 15,
            fontWeight: 600,
            padding: '0 24px',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          <RotateCcw size={16} aria-hidden />
          Перезагрузить
        </button>
        {error.digest ? (
          <p style={{ marginTop: 24, fontSize: 11.5, color: '#9ca3af' }}>
            Код ошибки: {error.digest}
          </p>
        ) : null}
      </body>
    </html>
  )
}
