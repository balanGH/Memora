import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box,
  Typography,
  Avatar,
  Grid,
  Card,
  CardActionArea,
  Button,
  Stack,
  Tooltip
} from '@mui/material'
import PersonIcon from '@mui/icons-material/Person'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import MergeIcon from '@mui/icons-material/Merge'
import VisibilityIcon from '@mui/icons-material/Visibility'
import { api, personFaceUrl, thumbUrl } from '../api/client'
import type { Person } from '../api/types'

export default function PeoplePage(): JSX.Element {
  const [people, setPeople] = useState<Person[]>([])
  const [hidden, setHidden] = useState<Person[]>([])
  const [showHidden, setShowHidden] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [mergeMode, setMergeMode] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [merging, setMerging] = useState(false)
  const navigate = useNavigate()

  const load = (): void => {
    // Fetch everything (incl. hidden) so we can offer an unhide list.
    api
      .people(true)
      .then((r) => {
        setPeople(r.people.filter((p) => !p.is_hidden))
        setHidden(r.people.filter((p) => p.is_hidden))
      })
      .finally(() => setLoaded(true))
  }
  useEffect(load, [])

  const unhide = async (id: number): Promise<void> => {
    await api.hidePerson(id, false)
    load()
  }

  const exitMerge = (): void => {
    setMergeMode(false)
    setSelected(new Set())
  }

  const toggleSelect = (id: number): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // Merge every selected head into one. Keep a named person if there is one
  // (so the name survives), otherwise the one with the most photos.
  const target = useMemo(() => {
    const chosen = people.filter((p) => selected.has(p.id))
    if (chosen.length === 0) return null
    return (
      chosen.find((p) => p.name && p.name.trim()) ??
      chosen.reduce((a, b) => (b.photo_count > a.photo_count ? b : a))
    )
  }, [people, selected])

  const doMerge = async (): Promise<void> => {
    if (!target || selected.size < 2) return
    setMerging(true)
    try {
      for (const id of selected) {
        if (id !== target.id) await api.mergePeople(id, target.id)
      }
      exitMerge()
      load()
    } finally {
      setMerging(false)
    }
  }

  const onCardClick = (p: Person): void => {
    if (mergeMode) toggleSelect(p.id)
    else navigate(`/people/${p.id}`)
  }

  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 3 }}>
      <Stack direction="row" alignItems="flex-start" sx={{ mb: 0.5 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            People
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            {mergeMode
              ? 'Select two or more heads that are the same person, then Merge.'
              : 'Faces are grouped automatically. Click a person to name them, or merge duplicate heads.'}
          </Typography>
        </Box>
        {mergeMode ? (
          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              startIcon={<MergeIcon />}
              disabled={selected.size < 2 || merging}
              onClick={doMerge}
            >
              {merging
                ? 'Merging…'
                : `Merge ${selected.size || ''}${
                    target?.name ? ` → ${target.name}` : ''
                  }`}
            </Button>
            <Button variant="outlined" onClick={exitMerge} disabled={merging}>
              Cancel
            </Button>
          </Stack>
        ) : (
          <Stack direction="row" spacing={1}>
            {hidden.length > 0 && (
              <Button
                variant={showHidden ? 'contained' : 'outlined'}
                color="inherit"
                startIcon={<VisibilityIcon />}
                onClick={() => setShowHidden((s) => !s)}
              >
                {showHidden ? 'Hide hidden' : `Hidden (${hidden.length})`}
              </Button>
            )}
            <Button
              variant="outlined"
              startIcon={<MergeIcon />}
              onClick={() => setMergeMode(true)}
              disabled={people.length < 2}
            >
              Merge duplicates
            </Button>
          </Stack>
        )}
      </Stack>

      {loaded && people.length === 0 && (
        <Typography color="text.secondary">
          No people yet. Scan a folder and let AI processing finish.
        </Typography>
      )}

      <Grid container spacing={2}>
        {people.map((p) => {
          const isSel = selected.has(p.id)
          return (
            <Grid item key={p.id} xs={6} sm={4} md={3} lg={2}>
              <Card
                variant="outlined"
                sx={{
                  borderRadius: 4,
                  position: 'relative',
                  borderColor: (t) =>
                    isSel ? t.palette.primary.main : t.palette.divider,
                  borderWidth: isSel ? 2 : 1
                }}
              >
                {mergeMode && isSel && (
                  <CheckCircleIcon
                    color="primary"
                    sx={{
                      position: 'absolute',
                      top: 6,
                      right: 6,
                      zIndex: 2,
                      bgcolor: 'background.paper',
                      borderRadius: '50%'
                    }}
                  />
                )}
                <CardActionArea
                  onClick={() => onCardClick(p)}
                  sx={{ p: 2, textAlign: 'center' }}
                >
                  <Avatar
                    src={personFaceUrl(p.id)}
                    imgProps={{
                      onError: (e) => {
                        const img = e.currentTarget
                        if (p.cover_media_id && !img.dataset.fallback) {
                          img.dataset.fallback = '1'
                          img.src = thumbUrl(p.cover_media_id)
                        }
                      }
                    }}
                    sx={{ width: 92, height: 92, mx: 'auto', mb: 1.5 }}
                  >
                    <PersonIcon sx={{ fontSize: 44 }} />
                  </Avatar>
                  <Typography noWrap sx={{ fontWeight: 600 }}>
                    {p.name ?? 'Add name'}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {p.photo_count} {p.photo_count === 1 ? 'photo' : 'photos'}
                  </Typography>
                </CardActionArea>
              </Card>
            </Grid>
          )
        })}
      </Grid>

      {showHidden && !mergeMode && hidden.length > 0 && (
        <Box sx={{ mt: 4 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1.5 }}>
            Hidden people
          </Typography>
          <Grid container spacing={2}>
            {hidden.map((p) => (
              <Grid item key={p.id} xs={6} sm={4} md={3} lg={2}>
                <Card variant="outlined" sx={{ borderRadius: 4, opacity: 0.75 }}>
                  <Box sx={{ p: 2, textAlign: 'center' }}>
                    <Avatar
                      src={personFaceUrl(p.id)}
                      imgProps={{
                        onError: (e) => {
                          const img = e.currentTarget
                          if (p.cover_media_id && !img.dataset.fallback) {
                            img.dataset.fallback = '1'
                            img.src = thumbUrl(p.cover_media_id)
                          }
                        }
                      }}
                      sx={{ width: 92, height: 92, mx: 'auto', mb: 1.5 }}
                    >
                      <PersonIcon sx={{ fontSize: 44 }} />
                    </Avatar>
                    <Typography noWrap sx={{ fontWeight: 600 }}>
                      {p.name ?? 'Unnamed'}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" display="block">
                      {p.photo_count} {p.photo_count === 1 ? 'photo' : 'photos'}
                    </Typography>
                    <Tooltip title="Unhide this person">
                      <Button
                        size="small"
                        startIcon={<VisibilityIcon />}
                        onClick={() => unhide(p.id)}
                        sx={{ mt: 1 }}
                      >
                        Unhide
                      </Button>
                    </Tooltip>
                  </Box>
                </Card>
              </Grid>
            ))}
          </Grid>
        </Box>
      )}
    </Box>
  )
}
