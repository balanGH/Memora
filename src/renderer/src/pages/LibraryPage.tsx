import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, ToggleButton, ToggleButtonGroup, MenuItem, TextField } from '@mui/material'
import PhotoGrid from '../components/PhotoGrid'
import PhotoViewer from '../components/PhotoViewer'
import { api } from '../api/client'
import type { LibraryView, MediaItem, SortKey } from '../api/types'
import type { Grouping } from '../components/dateGroups'

const PAGE = 200

const TITLES: Record<LibraryView, string> = {
  photos: 'Photos',
  favorites: 'Favorites',
  archive: 'Archive',
  hidden: 'Hidden',
  trash: 'Trash'
}

export default function LibraryPage({ view }: { view: LibraryView }): JSX.Element {
  const [items, setItems] = useState<MediaItem[]>([])
  const [sort, setSort] = useState<SortKey>('newest')
  const [grouping, setGrouping] = useState<Grouping>('day')
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const offset = useRef(0)
  const total = useRef(0)
  const loading = useRef(false)

  const load = useCallback(
    async (reset: boolean) => {
      if (loading.current) return
      loading.current = true
      const nextOffset = reset ? 0 : offset.current
      try {
        const page = await api.media(view, sort, PAGE, nextOffset)
        total.current = page.total
        offset.current = nextOffset + page.items.length
        setItems((prev) => (reset ? page.items : [...prev, ...page.items]))
      } finally {
        loading.current = false
      }
    },
    [view, sort]
  )

  useEffect(() => {
    offset.current = 0
    setItems([])
    load(true)
  }, [view, sort, load])

  const onEndReached = useCallback(() => {
    if (offset.current < total.current) load(false)
  }, [load])

  const refresh = useCallback(() => load(true), [load])

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box
        sx={{
          px: 2.5,
          py: 1.5,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          borderBottom: (t) => `1px solid ${t.palette.divider}`
        }}
      >
        <Box sx={{ fontSize: 20, fontWeight: 600 }}>{TITLES[view]}</Box>
        <Box sx={{ flex: 1 }} />
        <ToggleButtonGroup
          size="small"
          exclusive
          value={grouping}
          onChange={(_, v) => v && setGrouping(v)}
        >
          <ToggleButton value="day">Day</ToggleButton>
          <ToggleButton value="month">Month</ToggleButton>
          <ToggleButton value="year">Year</ToggleButton>
        </ToggleButtonGroup>
        <TextField
          select
          size="small"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          sx={{ minWidth: 150 }}
        >
          <MenuItem value="newest">Newest first</MenuItem>
          <MenuItem value="oldest">Oldest first</MenuItem>
          <MenuItem value="favorites">Favorites</MenuItem>
          <MenuItem value="added">Recently added</MenuItem>
        </TextField>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0 }}>
        <PhotoGrid
          items={items}
          grouping={grouping}
          onOpen={setViewerIndex}
          onEndReached={onEndReached}
        />
      </Box>

      {viewerIndex !== null && (
        <PhotoViewer
          items={items}
          index={viewerIndex}
          onClose={() => setViewerIndex(null)}
          onIndexChange={setViewerIndex}
          onMutate={refresh}
        />
      )}
    </Box>
  )
}
