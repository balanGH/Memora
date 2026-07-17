import type { MediaItem } from '../api/types'

export interface LaidOutTile {
  item: MediaItem
  width: number
  height: number
}

export type LaidOutRow = LaidOutTile[]

/**
 * Google-Photos-style justified rows: fills each row to the container width at a
 * roughly constant target height, letting the last row keep the target height.
 */
export function justifyRows(
  items: MediaItem[],
  containerWidth: number,
  targetHeight = 200,
  gap = 4
): LaidOutRow[] {
  if (containerWidth <= 0 || items.length === 0) return []
  const rows: LaidOutRow[] = []
  let current: MediaItem[] = []
  let aspectSum = 0

  const aspectOf = (m: MediaItem): number => {
    const w = m.width ?? 1
    const h = m.height ?? 1
    const a = w > 0 && h > 0 ? w / h : 1
    // clamp extreme panoramas so one photo can't dominate a row
    return Math.min(Math.max(a, 0.4), 3.2)
  }

  const flush = (isLast: boolean): void => {
    if (current.length === 0) return
    const gaps = gap * (current.length - 1)
    const available = containerWidth - gaps
    let rowHeight = available / aspectSum
    if (isLast) rowHeight = Math.min(rowHeight, targetHeight)
    rows.push(
      current.map((m) => ({
        item: m,
        width: Math.floor(aspectOf(m) * rowHeight),
        height: Math.floor(rowHeight)
      }))
    )
    current = []
    aspectSum = 0
  }

  for (const item of items) {
    current.push(item)
    aspectSum += aspectOf(item)
    const projectedWidth = aspectSum * targetHeight + gap * (current.length - 1)
    if (projectedWidth >= containerWidth) flush(false)
  }
  flush(true)
  return rows
}
