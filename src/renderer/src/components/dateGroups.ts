import type { MediaItem } from '../api/types'

export type Grouping = 'day' | 'month' | 'year'

function parse(taken: string | null): Date | null {
  if (!taken) return null
  const d = new Date(taken)
  return isNaN(d.getTime()) ? null : d
}

export function groupLabel(taken: string | null, grouping: Grouping): string {
  const d = parse(taken)
  if (!d) return 'Unknown date'
  if (grouping === 'year') return String(d.getFullYear())
  if (grouping === 'month')
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  })
}

export interface GroupedMedia {
  labels: string[]
  itemsByGroup: MediaItem[][]
}

/** Split an already-sorted media list into consecutive date groups. */
export function groupByDate(items: MediaItem[], grouping: Grouping): GroupedMedia {
  const labels: string[] = []
  const itemsByGroup: MediaItem[][] = []
  let lastLabel: string | null = null

  for (const item of items) {
    const label = groupLabel(item.taken_at, grouping)
    if (label !== lastLabel) {
      labels.push(label)
      itemsByGroup.push([])
      lastLabel = label
    }
    itemsByGroup[itemsByGroup.length - 1].push(item)
  }
  return { labels, itemsByGroup }
}
