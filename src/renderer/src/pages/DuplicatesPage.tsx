import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  LinearProgress,
  Paper,
  Stack,
  Tooltip,
  Typography
} from '@mui/material'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep'
import FavoriteIcon from '@mui/icons-material/Favorite'
import { api, thumbUrl } from '../api/client'
import type { DuplicateGroup } from '../api/types'
import { useMediaActions } from '../hooks/useMediaActions'

function fmtSize(bytes: number | null): string {
  if (!bytes) return '—'
  return bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`
}

/**
 * Exact duplicates (same file bytes). For each group the user picks which copy
 * to keep (default: a favorite, else the oldest) and the rest go to the trash,
 * with Undo.
 */
export default function DuplicatesPage(): JSX.Element {
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null)
  const [keep, setKeep] = useState<Record<string, number>>({})

  const load = useCallback(() => {
    api.duplicates().then((r) => {
      setGroups(r.groups)
      // Backend orders each group favorite-first, then oldest: keep that one.
      setKeep(Object.fromEntries(r.groups.map((g) => [g.hash, g.items[0].id])))
    })
  }, [])
  useEffect(load, [load])

  const { setFlag } = useMediaActions(load)

  const extrasOf = useCallback(
    (g: DuplicateGroup): number[] =>
      g.items.filter((i) => i.id !== keep[g.hash]).map((i) => i.id),
    [keep]
  )

  const allExtras = useMemo(
    () => (groups ?? []).flatMap((g) => extrasOf(g)),
    [groups, extrasOf]
  )
  const reclaimable = useMemo(
    () =>
      (groups ?? []).reduce(
        (sum, g) => sum + (g.items[0].size_bytes ?? 0) * (g.items.length - 1),
        0
      ),
    [groups]
  )

  if (groups === null) return <LinearProgress />

  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 3 }}>
      <Stack direction="row" alignItems="flex-start" sx={{ mb: 3 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            Duplicates
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Files with identical contents. Click the copy to keep; the others move to the
            trash. Files on disk are never deleted.
          </Typography>
        </Box>
        {groups.length > 0 && (
          <Button
            variant="contained"
            startIcon={<DeleteSweepIcon />}
            onClick={() => setFlag(allExtras, 'is_trashed', true)}
          >
            Trash {allExtras.length} extra copies
          </Button>
        )}
      </Stack>

      {groups.length === 0 ? (
        <Alert severity="success">
          No duplicates found. Duplicate detection runs during AI processing, so newly added
          files are checked once processing finishes.
        </Alert>
      ) : (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {groups.length} groups · about {fmtSize(reclaimable)} in extra copies
          </Typography>
          <Stack spacing={2}>
            {groups.map((g) => (
              <Paper key={g.hash} variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                <Stack direction="row" alignItems="center" sx={{ mb: 1.5 }}>
                  <Typography variant="subtitle2" sx={{ flex: 1 }}>
                    {g.items.length} copies · {fmtSize(g.items[0].size_bytes)} each
                  </Typography>
                  <Button
                    size="small"
                    startIcon={<DeleteSweepIcon />}
                    onClick={() => setFlag(extrasOf(g), 'is_trashed', true)}
                  >
                    Keep selected, trash others
                  </Button>
                </Stack>
                <Stack direction="row" spacing={1.5} sx={{ overflowX: 'auto', pb: 0.5 }}>
                  {g.items.map((item) => {
                    const kept = keep[g.hash] === item.id
                    return (
                      <Tooltip key={item.id} title={item.path}>
                        <Box
                          role="radio"
                          aria-checked={kept}
                          aria-label={`Keep ${item.path}`}
                          tabIndex={0}
                          onClick={() => setKeep((k) => ({ ...k, [g.hash]: item.id }))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              setKeep((k) => ({ ...k, [g.hash]: item.id }))
                            }
                          }}
                          sx={{
                            width: 160,
                            flexShrink: 0,
                            cursor: 'pointer',
                            borderRadius: 2,
                            p: 0.5,
                            outline: (t) =>
                              kept ? `2px solid ${t.palette.primary.main}` : 'none',
                            opacity: kept ? 1 : 0.65,
                            position: 'relative'
                          }}
                        >
                          <img
                            src={thumbUrl(item.id)}
                            alt={item.filename}
                            loading="lazy"
                            style={{
                              width: '100%',
                              height: 110,
                              objectFit: 'cover',
                              borderRadius: 6,
                              display: 'block'
                            }}
                          />
                          {kept && (
                            <CheckCircleIcon
                              color="primary"
                              sx={{
                                position: 'absolute',
                                top: 8,
                                right: 8,
                                bgcolor: 'background.paper',
                                borderRadius: '50%'
                              }}
                            />
                          )}
                          {item.is_favorite && (
                            <FavoriteIcon
                              sx={{ position: 'absolute', top: 8, left: 8, color: '#fff', fontSize: 18 }}
                            />
                          )}
                          <Typography variant="caption" noWrap component="div" sx={{ mt: 0.5 }}>
                            {kept ? 'Keep · ' : ''}
                            {item.path}
                          </Typography>
                        </Box>
                      </Tooltip>
                    )
                  })}
                </Stack>
              </Paper>
            ))}
          </Stack>
        </>
      )}
    </Box>
  )
}
