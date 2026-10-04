import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Box,
  Button,
  Chip,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import PhotoGrid, { type GridAction } from '../components/PhotoGrid'
import PhotoViewer from '../components/PhotoViewer'
import SelectionBar from '../components/SelectionBar'
import { api } from '../api/client'
import { useMediaActions } from '../hooks/useMediaActions'
import type { MediaItem, Person } from '../api/types'

const SUGGESTIONS = ['dog', 'cat', 'beach', 'sunset', 'car', 'laptop', 'birthday', 'city']

type Kind = 'all' | 'image' | 'video'

function yearOf(m: MediaItem): number | null {
  if (!m.taken_at) return null
  const y = new Date(m.taken_at).getFullYear()
  return Number.isNaN(y) ? null : y
}

export default function SearchPage(): JSX.Element {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const personId = Number(params.get('person')) || undefined
  const [items, setItems] = useState<MediaItem[]>([])
  const [loading, setLoading] = useState(false)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [people, setPeople] = useState<Person[]>([])
  // Client-side filters on the result set.
  const [kind, setKind] = useState<Kind>('all')
  const [favOnly, setFavOnly] = useState(false)
  const [fromYear, setFromYear] = useState<number | ''>('')
  const [toYear, setToYear] = useState<number | ''>('')

  const run = useCallback(async () => {
    if (!q.trim()) {
      setItems([])
      return
    }
    setLoading(true)
    try {
      const r = await api.search(q, personId)
      setItems(r.items)
    } finally {
      setLoading(false)
    }
  }, [q, personId])

  useEffect(() => {
    setSelected(new Set())
    run()
  }, [run])

  useEffect(() => {
    api.people().then((r) => setPeople(r.people.filter((p) => p.name))).catch(() => {})
  }, [])

  const years = useMemo(() => {
    const ys = new Set<number>()
    items.forEach((m) => {
      const y = yearOf(m)
      if (y) ys.add(y)
    })
    return [...ys].sort((a, b) => a - b)
  }, [items])

  const shown = useMemo(
    () =>
      items.filter((m) => {
        if (kind !== 'all' && m.kind !== kind) return false
        if (favOnly && !m.is_favorite) return false
        const y = yearOf(m)
        if (fromYear !== '' && (y === null || y < fromYear)) return false
        if (toYear !== '' && (y === null || y > toYear)) return false
        return true
      }),
    [items, kind, favOnly, fromYear, toYear]
  )

  const filtersOn = kind !== 'all' || favOnly || fromYear !== '' || toYear !== '' || !!personId
  const clearFilters = (): void => {
    setKind('all')
    setFavOnly(false)
    setFromYear('')
    setToYear('')
    setParams({ q })
  }

  const setPerson = (id: number | ''): void => {
    const next: Record<string, string> = { q }
    if (id) next.person = String(id)
    setParams(next)
  }

  const { setFlag } = useMediaActions(run)
  const onAction = (action: GridAction, ids: number[]): void => {
    const chosen = shown.filter((m) => ids.includes(m.id))
    if (action === 'favorite') setFlag(ids, 'is_favorite', !chosen.every((m) => m.is_favorite))
    else if (action === 'archive') setFlag(ids, 'is_archived', true)
    else setFlag(ids, 'is_trashed', true)
    if (action !== 'favorite') setSelected(new Set())
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {selected.size > 0 ? (
        <SelectionBar
          items={shown}
          selected={selected}
          onChange={setSelected}
          view="search"
          onMutate={run}
        />
      ) : (
        <Box sx={{ px: 3, py: 2 }}>
          <Typography variant="h5" component="h1" sx={{ fontWeight: 600 }}>
            {q ? `Results for “${q}”` : 'Search'}
          </Typography>
          {!q && (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 1.5 }}>
                Search across people, objects, scenes and text in photos. Press Ctrl+K from
                anywhere.
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {SUGGESTIONS.map((s) => (
                  <Chip key={s} label={s} variant="outlined" onClick={() => setParams({ q: s })} />
                ))}
              </Stack>
            </>
          )}
          {q && (
            <Stack
              direction="row"
              spacing={1.5}
              alignItems="center"
              flexWrap="wrap"
              useFlexGap
              sx={{ mt: 1.5 }}
              role="group"
              aria-label="Filter results"
            >
              <ToggleButtonGroup
                size="small"
                exclusive
                value={kind}
                onChange={(_, v) => v && setKind(v)}
                aria-label="Media type"
              >
                <ToggleButton value="all">All</ToggleButton>
                <ToggleButton value="image">Photos</ToggleButton>
                <ToggleButton value="video">Videos</ToggleButton>
              </ToggleButtonGroup>
              <TextField
                select
                size="small"
                label="Person"
                value={personId ?? ''}
                onChange={(e) => setPerson(e.target.value ? Number(e.target.value) : '')}
                sx={{ minWidth: 150 }}
              >
                <MenuItem value="">Anyone</MenuItem>
                {people.map((p) => (
                  <MenuItem key={p.id} value={p.id}>
                    {p.name}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                select
                size="small"
                label="From"
                value={fromYear}
                onChange={(e) => setFromYear(e.target.value === '' ? '' : Number(e.target.value))}
                sx={{ minWidth: 100 }}
              >
                <MenuItem value="">Any</MenuItem>
                {years.map((y) => (
                  <MenuItem key={y} value={y}>
                    {y}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                select
                size="small"
                label="To"
                value={toYear}
                onChange={(e) => setToYear(e.target.value === '' ? '' : Number(e.target.value))}
                sx={{ minWidth: 100 }}
              >
                <MenuItem value="">Any</MenuItem>
                {years.map((y) => (
                  <MenuItem key={y} value={y}>
                    {y}
                  </MenuItem>
                ))}
              </TextField>
              <FormControlLabel
                control={<Switch size="small" checked={favOnly} onChange={(e) => setFavOnly(e.target.checked)} />}
                label="Favorites only"
              />
              {filtersOn && (
                <Button size="small" onClick={clearFilters}>
                  Clear filters
                </Button>
              )}
              <Box sx={{ flex: 1 }} />
              {!loading && (
                <Typography variant="caption" color="text.secondary" aria-live="polite">
                  {shown.length}
                  {shown.length !== items.length ? ` of ${items.length}` : ''} match
                  {shown.length === 1 ? '' : 'es'}
                </Typography>
              )}
            </Stack>
          )}
        </Box>
      )}
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <PhotoGrid
          items={shown}
          grouping="year"
          onOpen={setViewerIndex}
          loading={loading}
          selected={selected}
          onSelectedChange={setSelected}
          onAction={onAction}
          ariaLabel="Search results"
          emptyState={
            q ? (
              <Box sx={{ textAlign: 'center', mt: 8, color: 'text.secondary' }}>
                <Typography variant="h6">No matches</Typography>
                <Typography variant="body2">
                  {filtersOn
                    ? 'Try clearing the filters.'
                    : 'Try another word, or a person’s name.'}
                </Typography>
              </Box>
            ) : (
              <Box />
            )
          }
        />
      </Box>
      {viewerIndex !== null && (
        <PhotoViewer
          items={shown}
          index={viewerIndex}
          onClose={() => setViewerIndex(null)}
          onIndexChange={setViewerIndex}
          onMutate={run}
        />
      )}
    </Box>
  )
}
