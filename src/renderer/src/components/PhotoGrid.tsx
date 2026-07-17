import { useMemo, useRef, useState, useLayoutEffect } from 'react'
import { GroupedVirtuoso } from 'react-virtuoso'
import { Box, Typography } from '@mui/material'
import type { MediaItem } from '../api/types'
import { groupByDate, type Grouping } from './dateGroups'
import { justifyRows, type LaidOutRow } from './justifiedLayout'
import PhotoTile from './PhotoTile'

interface Props {
  items: MediaItem[]
  grouping?: Grouping
  onOpen: (index: number) => void
  onEndReached?: () => void
}

const GAP = 4
const PAD = 20

export default function PhotoGrid({
  items,
  grouping = 'day',
  onOpen,
  onEndReached
}: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

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

  // Map global item index -> position in the flat items array, so clicking a
  // tile opens the right photo in the viewer.
  const { groupCounts, labels, flatRows, rowStartIndex } = useMemo(() => {
    const grouped = groupByDate(items, grouping)
    const flat: { row: LaidOutRow; baseIndex: number }[] = []
    const counts: number[] = []
    let runningIndex = 0
    grouped.itemsByGroup.forEach((groupItems) => {
      const rows = width > 0 ? justifyRows(groupItems, width, 200, GAP) : []
      counts.push(rows.length)
      rows.forEach((row) => {
        flat.push({ row, baseIndex: runningIndex })
        runningIndex += row.length
      })
    })
    return {
      groupCounts: counts,
      labels: grouped.labels,
      flatRows: flat,
      rowStartIndex: 0
    }
  }, [items, grouping, width])

  void rowStartIndex

  if (items.length === 0) {
    return (
      <Box
        ref={containerRef}
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
  }

  return (
    <Box ref={containerRef} sx={{ height: '100%' }}>
      {width > 0 && (
        <GroupedVirtuoso
          style={{ height: '100%' }}
          groupCounts={groupCounts}
          endReached={onEndReached}
          increaseViewportBy={{ top: 600, bottom: 900 }}
          groupContent={(index) => (
            <Box
              sx={{
                px: `${PAD}px`,
                pt: 2.5,
                pb: 1,
                bgcolor: 'background.default',
                backdropFilter: 'blur(6px)'
              }}
            >
              <Typography variant="subtitle1">{labels[index]}</Typography>
            </Box>
          )}
          itemContent={(index) => {
            const entry = flatRows[index]
            if (!entry) return null
            return (
              <Box
                sx={{ display: 'flex', gap: `${GAP}px`, px: `${PAD}px`, mb: `${GAP}px` }}
              >
                {entry.row.map((tile, i) => (
                  <PhotoTile
                    key={tile.item.id}
                    item={tile.item}
                    width={tile.width}
                    height={tile.height}
                    onClick={() => onOpen(entry.baseIndex + i)}
                  />
                ))}
              </Box>
            )
          }}
        />
      )}
    </Box>
  )
}
