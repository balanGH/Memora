import { useEffect, useMemo, useState } from 'react'
import {
  Autocomplete,
  Avatar,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import PersonIcon from '@mui/icons-material/Person'
import { api, personFaceUrl, thumbUrl } from '../api/client'
import type { MediaItem, Person } from '../api/types'
import { useNotify } from '../context/FeedbackContext'

interface Props {
  open: boolean
  people: Person[]
  onClose: () => void
}

/**
 * "Who is this?" — steps through unnamed people one at a time. Typing a name
 * that already exists merges the two, so repeat faces collapse as you go.
 */
export default function NamePeopleDialog({ open, people, onClose }: Props): JSX.Element {
  // Snapshot the queue when the dialog opens so it doesn't shift under the user.
  const [queue, setQueue] = useState<Person[]>([])
  const [pos, setPos] = useState(0)
  const [name, setName] = useState('')
  const [samples, setSamples] = useState<MediaItem[]>([])
  const [named, setNamed] = useState<{ id: number; name: string }[]>([])
  const [busy, setBusy] = useState(false)
  const notify = useNotify()

  useEffect(() => {
    if (!open) return
    setQueue(people.filter((p) => !p.name).sort((a, b) => b.photo_count - a.photo_count))
    setNamed(people.filter((p) => p.name).map((p) => ({ id: p.id, name: p.name as string })))
    setPos(0)
    setName('')
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const current = queue[pos]

  useEffect(() => {
    setSamples([])
    if (current) {
      api
        .personMedia(current.id)
        .then((r) => setSamples(r.items.slice(0, 6)))
        .catch(() => {})
    }
  }, [current?.id])

  const names = useMemo(() => [...new Set(named.map((n) => n.name))].sort(), [named])

  const advance = (): void => {
    setName('')
    if (pos + 1 >= queue.length) {
      notify('All caught up — everyone has a name')
      onClose()
    } else {
      setPos((p) => p + 1)
    }
  }

  const save = async (): Promise<void> => {
    const n = name.trim()
    if (!current || !n) return advance()
    setBusy(true)
    try {
      const existing = named.find((x) => x.name.toLowerCase() === n.toLowerCase())
      if (existing) {
        await api.mergePeople(current.id, existing.id)
        notify(`Merged into ${existing.name}`)
      } else {
        await api.renamePerson(current.id, n)
        setNamed((list) => [...list, { id: current.id, name: n }])
      }
      advance()
    } finally {
      setBusy(false)
    }
  }

  const hide = async (): Promise<void> => {
    if (!current) return
    await api.hidePerson(current.id, true)
    notify('Hidden from People', {
      undo: () => api.hidePerson(current.id, false)
    })
    advance()
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Who is this?</DialogTitle>
      {queue.length === 0 ? (
        <DialogContent>
          <Typography color="text.secondary">Everyone already has a name.</Typography>
        </DialogContent>
      ) : current ? (
        <DialogContent>
          <LinearProgress
            variant="determinate"
            value={(pos / queue.length) * 100}
            sx={{ mb: 2, borderRadius: 2 }}
            aria-label={`Person ${pos + 1} of ${queue.length}`}
          />
          <Stack direction="row" spacing={2.5} alignItems="center" sx={{ mb: 2 }}>
            <Avatar
              src={personFaceUrl(current.id)}
              alt="Face to name"
              sx={{ width: 112, height: 112 }}
              imgProps={{
                onError: (e) => {
                  const img = e.currentTarget
                  if (current.cover_media_id && !img.dataset.fallback) {
                    img.dataset.fallback = '1'
                    img.src = thumbUrl(current.cover_media_id)
                  }
                }
              }}
            >
              <PersonIcon sx={{ fontSize: 56 }} />
            </Avatar>
            <Box sx={{ flex: 1 }}>
              <Typography variant="caption" color="text.secondary">
                {pos + 1} of {queue.length} · in {current.photo_count}{' '}
                {current.photo_count === 1 ? 'photo' : 'photos'}
              </Typography>
              <Autocomplete
                freeSolo
                options={names}
                inputValue={name}
                onInputChange={(_, v) => setName(v)}
                renderInput={(p) => (
                  <TextField
                    {...p}
                    autoFocus
                    label="Name"
                    placeholder="Type a name, or pick someone to merge"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.defaultPrevented) {
                        e.preventDefault()
                        save()
                      }
                    }}
                    sx={{ mt: 1 }}
                  />
                )}
              />
              {names.some((n) => n.toLowerCase() === name.trim().toLowerCase()) && (
                <Typography variant="caption" color="primary">
                  Will merge with the existing “{name.trim()}”
                </Typography>
              )}
            </Box>
          </Stack>
          <Stack direction="row" spacing={1} sx={{ overflowX: 'auto' }}>
            {samples.map((m) => (
              <img
                key={m.id}
                src={thumbUrl(m.id)}
                alt=""
                style={{ height: 72, borderRadius: 6, flexShrink: 0 }}
              />
            ))}
          </Stack>
        </DialogContent>
      ) : null}
      <DialogActions>
        {current && (
          <>
            <Button onClick={hide} color="inherit" disabled={busy}>
              Not a person / hide
            </Button>
            <Box sx={{ flex: 1 }} />
            <Button onClick={advance} disabled={busy}>
              Skip
            </Button>
            <Button variant="contained" onClick={save} disabled={busy || !name.trim()}>
              Save & next
            </Button>
          </>
        )}
        {!current && <Button onClick={onClose}>Close</Button>}
      </DialogActions>
    </Dialog>
  )
}
