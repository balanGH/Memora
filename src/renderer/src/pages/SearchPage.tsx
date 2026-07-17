import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Box, Typography, Chip, Stack } from '@mui/material'
import PhotoGrid from '../components/PhotoGrid'
import PhotoViewer from '../components/PhotoViewer'
import { api } from '../api/client'
import type { MediaItem } from '../api/types'

const SUGGESTIONS = ['dog', 'cat', 'beach', 'sunset', 'car', 'laptop', 'birthday', 'city']

export default function SearchPage(): JSX.Element {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const [items, setItems] = useState<MediaItem[]>([])
  const [loading, setLoading] = useState(false)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)

  const run = useCallback(async (query: string) => {
    if (!query.trim()) {
      setItems([])
      return
    }
    setLoading(true)
    try {
      const r = await api.search(query)
      setItems(r.items)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    run(q)
  }, [q, run])

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ px: 3, py: 2 }}>
        <Typography variant="h5" sx={{ fontWeight: 600 }}>
          {q ? `Results for “${q}”` : 'Search'}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 1.5 }}>
          Natural-language search across people, objects, scenes, and text.
        </Typography>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {SUGGESTIONS.map((s) => (
            <Chip
              key={s}
              label={s}
              variant={q === s ? 'filled' : 'outlined'}
              color={q === s ? 'primary' : 'default'}
              onClick={() => setParams({ q: s })}
            />
          ))}
        </Stack>
        {q && !loading && (
          <Typography variant="caption" color="text.secondary">
            {items.length} match{items.length === 1 ? '' : 'es'}
          </Typography>
        )}
      </Box>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <PhotoGrid items={items} grouping="year" onOpen={setViewerIndex} />
      </Box>
      {viewerIndex !== null && (
        <PhotoViewer
          items={items}
          index={viewerIndex}
          onClose={() => setViewerIndex(null)}
          onIndexChange={setViewerIndex}
          onMutate={() => run(q)}
        />
      )}
    </Box>
  )
}
