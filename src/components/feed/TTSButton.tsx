'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Pause, Play, Volume2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { haptic } from '@/lib/tg'

/**
 * Озвучка поста (кнопка «Слушать»): один тап — пост читается голосом.
 * Аудио кэшируется на сервере (Post.ttsAudio), повторное включение мгновенно.
 * Плеер — общий синглтон: включение новой озвучки останавливает прежнюю.
 */

type Status = 'idle' | 'loading' | 'ready' | 'playing'

let sharedAudio: HTMLAudioElement | null = null
let sharedPostId: string | null = null

function getAudio(): HTMLAudioElement {
  if (!sharedAudio) {
    sharedAudio = new Audio()
    sharedAudio.preload = 'auto'
  }
  return sharedAudio
}

export function useTTS(postId: string, text: string) {
  const [status, setStatus] = useState<Status>('idle')
  const mounted = useRef(true)
  const t = useT()

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      // уход с экрана — глушим звук, если играет именно этот пост
      if (sharedPostId === postId) {
        getAudio().pause()
        setStatus((s) => (s === 'playing' ? 'ready' : s))
      }
    }
  }, [postId])

  const toggle = useCallback(async () => {
    const audio = getAudio()

    // Повторный тап по играющему — пауза/плей без запросов
    if (sharedPostId === postId && (status === 'playing' || status === 'ready')) {
      haptic('light')
      if (audio.paused) {
        await audio.play().catch(() => {})
        setStatus('playing')
      } else {
        audio.pause()
        setStatus('ready')
      }
      return
    }

    haptic('light')
    setStatus('loading')
    try {
      const r = await api<{ ok: boolean; audio?: string; reason?: string }>('/api/tts', {
        method: 'POST',
        body: JSON.stringify({ postId }),
      })
      if (!r.ok || !r.audio) {
        setStatus('idle')
        toast.error(r.reason === 'short' ? t('tts.tooShort') : t('tts.unavailable'))
        return
      }
      audio.src = `data:audio/mpeg;base64,${r.audio}`
      sharedPostId = postId
      audio.onended = () => {
        if (sharedPostId === postId && mounted.current) setStatus('ready')
      }
      try {
        await audio.play()
        if (mounted.current) setStatus('playing')
      } catch (e) {
        // Браузер мог заблокировать автозапуск (нет user-жеста) —
        // оставляем «готово»: повторный тап включит воспроизведение
        if ((e as DOMException)?.name === 'NotAllowedError') {
          if (mounted.current) setStatus('ready')
        } else throw e
      }
    } catch {
      setStatus('idle')
      toast.error(t('tts.error'))
    }
  }, [postId, status])

  return { status, toggle }
}

/** Кнопка озвучки: компактная, для мета-строки поста или панели оверлея */
export function ListenButton({
  postId,
  text,
  className,
}: {
  postId: string
  text: string
  className?: string
}) {
  const { status, toggle } = useTTS(postId, text)
  const t = useT()
  const busy = status === 'loading'

  return (
    <button
      type="button"
      data-noswipe
      onClick={(e) => {
        e.stopPropagation()
        void toggle()
      }}
      aria-label={status === 'playing' ? t('tts.pause') : t('tts.aria')}
      className={cn(
        'inline-flex items-center gap-1.5 text-[13px] font-medium transition active:opacity-60',
        status === 'playing' ? 'text-tg-link' : 'text-tg-hint',
        className,
      )}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : status === 'playing' ? (
        <Pause className="h-3.5 w-3.5" aria-hidden />
      ) : status === 'ready' ? (
        <Play className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <Volume2 className="h-3.5 w-3.5" aria-hidden />
      )}
      {status === 'playing' ? t('tts.playing') : t('tts.listen')}
    </button>
  )
}
