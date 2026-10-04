import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { ScanState } from '../api/types'

/*
 * One shared poller for scan/AI status. Several components (top bar, sidebar,
 * library, settings) need it; sharing avoids each one hitting the backend on
 * its own timer. Polls quickly while work is running, slowly when idle, and
 * stops entirely when nothing is subscribed.
 */
type Listener = (s: ScanState) => void

const listeners = new Set<Listener>()
let latest: ScanState | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let inFlight = false

async function tick(): Promise<void> {
  timer = null
  if (inFlight) return
  inFlight = true
  let busy = false
  try {
    const s = await api.scanStatus()
    latest = s
    busy = s.scan.running || s.ai.running
    listeners.forEach((l) => l(s))
  } catch {
    // backend not up yet; retry on the slow interval
  } finally {
    inFlight = false
  }
  if (listeners.size > 0 && !timer) timer = setTimeout(tick, busy ? 700 : 4000)
}

/** Poll right away (e.g. after starting a scan) instead of waiting for the timer. */
export function refreshScanStatus(): void {
  if (timer) clearTimeout(timer)
  tick()
}

export function useScanStatus(): ScanState | null {
  const [state, setState] = useState<ScanState | null>(latest)

  useEffect(() => {
    listeners.add(setState)
    if (listeners.size === 1 && !timer) tick()
    return () => {
      listeners.delete(setState)
      if (listeners.size === 0 && timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }, [])

  return state
}
