import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import { GroupedVirtuoso, type GroupedVirtuosoHandle } from 'react-virtuoso'
import { Box, IconButton, Skeleton, Tooltip, Typography } from '@mui/material'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked'
import type { MediaItem } from '../api/types'
import { groupByDate, type Grouping } from './dateGroups'
import { justifyRows, type LaidOutRow } from './justifiedLayout'
import PhotoTile from './PhotoTile'

export type GridAction = 'favorite' | 'trash' | 'archive'

interface Props {
  items: MediaItem[]
  grouping?: Grouping
  onOpen: (index: number) => void
  onEndReached?: () => void
  /** Show skeleton tiles while the first page loads. */
  loading?: boolean
  /** Rendered instead of the grid when there are no items. */
  emptyState?: ReactNode
  /** Selected media ids. Selection is enabled when onSelectedChange is set. */
  selected?: Set<number>
  onSelectedChange?: (next: Set<number>) => void
  /** Keyboard shortcuts (f / Delete / e) on the selection or focused photo. */
  onAction?: (action: GridAction, ids: number[]) => void
  ariaLabel?: string
}

export interface PhotoGridHandle {
  /** Scroll so the item at this index is visible, and focus it. */
  scrollToItem: (index: number) => void
}

const GAP = 4
const PAD = 20
const TARGET_ROW = 200
const EMPTY = new Set<number>()

const PhotoGrid = forwardRef<PhotoGridHandle, Props>(function PhotoGrid(
  {
    items,
    grouping = 'day',
    onOpen,
    onEndReached,
    loading,
    emptyState,
    selected = EMPTY,
    onSelectedChange,
    onAction,
    ariaLabel = 'Photos'
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const virtuoso = useRef<GroupedVirtuosoHandle>(null)
  const [width, setWidth] = useState(0)
  const [focused, setFocused] = useState<number | null>(null)
  const anchor = useRef<number | null>(null) // shift-click range start
  const drag = useRef<boolean | null>(null) // value being painted by a drag-select
  const selectable = !!onSelectedChange
  const selectionActive = selected.size > 0

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width - PAD * 2
      setWidth(w > 0 ? w : 0)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Stop a drag-select when the mouse is released anywhere.
  useEffect(() => {
    const up = (): void => {
      drag.current = null
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  // Lay out justified rows per date group; remember each row's first index.
  const { groupCounts, labels, flatRows, groupRanges } = useMemo(() => {
    const grouped = groupByDate(items, grouping)
    const flat: { row: LaidOutRow; baseIndex: number }[] = []
    const counts: number[] = []
    const ranges: [number, number][] = []
    let runningIndex = 0
    grouped.itemsByGroup.forEach((groupItems) => {
      const start = runningIndex
      const rows = width > 0 ? justifyRows(groupItems, width, TARGET_ROW, GAP) : []
      counts.push(rows.length)
      rows.forEach((row) => {
        flat.push({ row, baseIndex: runningIndex })
        runningIndex += row.length
      })
      ranges.push([start, start + groupItems.length])
    })
    return { groupCounts: counts, labels: grouped.labels, flatRows: flat, groupRanges: ranges }
  }, [items, grouping, width])

  const rowOf = useCallback(
    (index: number): number => {
      // Binary search: last row whose baseIndex <= index.
      let lo = 0
      let hi = flatRows.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (flatRows[mid].baseIndex <= index) lo = mid
        else hi = mid - 1
      }
      return lo
    },
    [flatRows]
  )

  const reveal = useCallback(
    (index: number) => {
      if (!flatRows.length) return
      virtuoso.current?.scrollIntoView({ index: rowOf(index), behavior: 'auto' })
    },
    [flatRows.length, rowOf]
  )

  useImperativeHandle(
    ref,
    () => ({
      scrollToItem: (index: number) => {
        if (!flatRows.length) return
        virtuoso.current?.scrollToIndex({ index: rowOf(index), align: 'start' })
        setFocused(index)
      }
    }),
    [flatRows.length, rowOf]
  )

  // Keep focus in range when the list shrinks (e.g. after trashing).
  useEffect(() => {
    if (focused !== null && focused >= items.length) {
      setFocused(items.length ? items.length - 1 : null)
    }
  }, [items.length, focused])

  const setSel = useCallback(
    (mutate: (next: Set<number>) => void) => {
      if (!onSelectedChange) return
      const next = new Set(selected)
      mutate(next)
      onSelectedChange(next)
    },
    [selected, onSelectedChange]
  )

  const toggle = useCallback(
    (index: number) => {
      const id = items[index]?.id
      if (id === undefined) return
      anchor.current = index
      setSel((s) => (s.has(id) ? s.delete(id) : s.add(id)))
    },
    [items, setSel]
  )

  const selectRange = useCallback(
    (index: number) => {
      const from = anchor.current ?? index
      const [a, b] = from < index ? [from, index] : [index, from]
      setSel((s) => {
        for (let i = a; i <= b; i++) s.add(items[i].id)
      })
    },
    [items, setSel]
  )

  const onTileClick = (index: number, e: MouseEvent): void => {
    setFocused(index)
    containerRef.current?.focus({ preventScroll: true })
    if (selectable && e.shiftKey && anchor.current !== null) selectRange(index)
    else if (selectable && (e.ctrlKey || e.metaKey || selectionActive)) toggle(index)
    else onOpen(index)
  }

  const onCheckMouseDown = (index: number, e: MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (e.shiftKey && anchor.current !== null) {
      selectRange(index)
      return
    }
    // Start painting: dragging across tiles applies the same value.
    drag.current = !selected.has(items[index].id)
    toggle(index)
  }

  const onTileEnter = (index: number): void => {
    if (drag.current === null) return
    const id = items[index].id
    const value = drag.current
    setSel((s) => (value ? s.add(id) : s.delete(id)))
  }

  const toggleGroup = (g: number): void => {
    const [a, b] = groupRanges[g]
    const ids = items.slice(a, b).map((i) => i.id)
    const all = ids.every((id) => selected.has(id))
    setSel((s) => ids.forEach((id) => (all ? s.delete(id) : s.add(id))))
  }

  const move = (index: number): void => {
    const clamped = Math.max(0, Math.min(items.length - 1, index))
    setFocused(clamped)
    reveal(clamped)
    if (clamped >= items.length - 1) onEndReached?.()
  }

  const moveRow = (from: number, delta: number): void => {
    const r = rowOf(from)
    const target = flatRows[r + delta]
    if (!target) return
    const col = from - flatRows[r].baseIndex
    move(target.baseIndex + Math.min(col, target.row.length - 1))
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!items.length) return
    const cur = focused ?? -1
    const ids = selectionActive
      ? [...selected]
      : focused !== null && items[focused]
        ? [items[focused].id]
        : []
    const handled = (): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    switch (e.key) {
      case 'ArrowRight':
        handled()
        move(cur + 1)
        break
      case 'ArrowLeft':
        handled()
        move(cur < 0 ? 0 : cur - 1)
        break
      case 'ArrowDown':
        handled()
        if (cur < 0) move(0)
        else moveRow(cur, 1)
        break
      case 'ArrowUp':
        handled()
        if (cur < 0) move(0)
        else moveRow(cur, -1)
        break
      case 'Home':
        handled()
        move(0)
        break
      case 'End':
        handled()
        move(items.length - 1)
        break
      case 'Enter':
        if (focused !== null) {
          handled()
          onOpen(focused)
        }
        break
      case ' ':
        if (selectable && focused !== null) {
          handled()
          if (e.shiftKey) selectRange(focused)
          else toggle(focused)
        }
        break
      case 'Escape':
        if (selectionActive) {
          handled()
          onSelectedChange?.(new Set())
        }
        break
      case 'a':
        if ((e.ctrlKey || e.metaKey) && selectable) {
          handled()
          onSelectedChange?.(new Set(items.map((i) => i.id)))
        }
        break
      case 'f':
        if (onAction && ids.length && !e.ctrlKey && !e.metaKey) {
          handled()
          onAction('favorite', ids)
        }
        break
      case 'e':
        if (onAction && ids.length && !e.ctrlKey && !e.metaKey) {
          handled()
          onAction('archive', ids)
        }
        break
      case 'Delete':
      case 'Backspace':
        if (onAction && ids.length) {
          handled()
          onAction('trash', ids)
        }
        break
    }
  }

  if (items.length === 0) {
    return (
      <Box ref={containerRef} sx={{ height: '100%', overflow: 'hidden' }}>
        {loading ? (
          <SkeletonGrid />
        ) : (
          emptyState ?? (
            <Box
              sx={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexDirection: 'column',
                color: 'text.secondary'
              }}
            >
              <Typography variant="h6">Nothing here yet</Typography>
              <Typography variant="body2">
                Add a folder in Settings and scan to see your photos.
              </Typography>
            </Box>
          )
        )}
      </Box>
    )
  }

  const focusedId = focused !== null ? items[focused]?.id : undefined

  return (
    <Box
      ref={containerRef}
      role="grid"
      aria-label={ariaLabel}
      aria-multiselectable={selectable || undefined}
      aria-activedescendant={focusedId !== undefined ? `tile-${focusedId}` : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={() => focused === null && setFocused(0)}
      sx={{ height: '100%', outline: 'none', userSelect: 'none' }}
    >
      {width > 0 && (
        <GroupedVirtuoso
          ref={virtuoso}
          style={{ height: '100%' }}
          groupCounts={groupCounts}
          endReached={onEndReached}
          increaseViewportBy={{ top: 600, bottom: 900 }}
          groupContent={(g) => {
            const [a, b] = groupRanges[g] ?? [0, 0]
            const allSelected =
              selectionActive && items.slice(a, b).every((i) => selected.has(i.id))
            return (
              <Box
                sx={{
                  px: `${PAD}px`,
                  pt: 2.5,
                  pb: 1,
                  bgcolor: 'background.default',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  '&:hover .memora-group-check': { opacity: 1 }
                }}
              >
                {selectable && (
                  <Tooltip title={allSelected ? 'Deselect this date' : 'Select this date'}>
                    <IconButton
                      size="small"
                      className="memora-group-check"
                      aria-label={`${allSelected ? 'Deselect' : 'Select'} all from ${labels[g]}`}
                      onClick={() => toggleGroup(g)}
                      sx={{
                        ml: -1,
                        opacity: selectionActive ? 1 : 0,
                        transition: 'opacity 0.15s',
                        '&:focus-visible': { opacity: 1 }
                      }}
                    >
                      {allSelected ? (
                        <CheckCircleIcon fontSize="small" color="primary" />
                      ) : (
                        <RadioButtonUncheckedIcon fontSize="small" />
                      )}
                    </IconButton>
                  </Tooltip>
                )}
                <Typography variant="subtitle1" component="h2">
                  {labels[g]}
                </Typography>
              </Box>
            )
          }}
          itemContent={(index) => {
            const entry = flatRows[index]
            if (!entry) return null
            return (
              <Box
                role="row"
                sx={{ display: 'flex', gap: `${GAP}px`, px: `${PAD}px`, mb: `${GAP}px` }}
              >
                {entry.row.map((tile, i) => {
                  const idx = entry.baseIndex + i
                  return (
                    <PhotoTile
                      key={tile.item.id}
                      item={tile.item}
                      width={tile.width}
                      height={tile.height}
                      onClick={(e) => onTileClick(idx, e)}
                      selectable={selectable}
                      selected={selected.has(tile.item.id)}
                      selectionActive={selectionActive}
                      focused={focused === idx}
                      onCheckMouseDown={(e) => onCheckMouseDown(idx, e)}
                      onMouseEnter={() => onTileEnter(idx)}
                    />
                  )
                })}
              </Box>
            )
          }}
        />
      )}
    </Box>
  )
})

export default PhotoGrid

/** Placeholder tiles shown while the first page of photos loads. */
function SkeletonGrid(): JSX.Element {
  const widths = [220, 160, 300, 200, 180, 260, 150, 240, 210, 170, 280, 190]
  return (
    <Box sx={{ px: `${PAD}px`, pt: 2.5 }} aria-busy="true" aria-label="Loading photos">
      <Skeleton variant="text" width={180} height={28} sx={{ mb: 1 }} />
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: `${GAP}px` }}>
        {widths.concat(widths).map((w, i) => (
          <Skeleton
            key={i}
            variant="rounded"
            width={w}
            height={TARGET_ROW * 0.8}
            sx={{ flexGrow: 1 }}
          />
        ))}
      </Box>
    </Box>
  )
}
