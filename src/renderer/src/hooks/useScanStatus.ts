import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import type { ScanState } from '../api/types'

/**
 * Polls the backend scan/AI status. Polls quickly while work is running and
 * backs off to a slow heartbeat when idle.
 */
export function useScanStatus(): ScanState | null {
  const [state, setState] = useState<ScanState | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false

    const tick = async (): Promise<void> => {
      try {
        const s = await api.scanStatus()
        if (!cancelled) setState(s)
        const busy = s.scan.running || s.ai.running
        timer.current = setTimeout(tick, busy ? 700 : 4000)
      } catch {
        timer.current = setTimeout(tick, 4000)
      }
    }

    tick()
    return () => {
      cancelled = true
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  return state
}
