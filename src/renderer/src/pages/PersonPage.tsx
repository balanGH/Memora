import { useCallback, useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Box,
  IconButton,
  TextField,
  Button,
  Stack,
  Tooltip,
  Snackbar,
  Alert,
  CircularProgress,
  Avatar,
  Badge,
  Dialog,
  DialogTitle,
  DialogContent,
  ImageList,
  ImageListItem
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import DriveFileMoveIcon from '@mui/icons-material/DriveFileMove'
import EditIcon from '@mui/icons-material/Edit'
import CallSplitIcon from '@mui/icons-material/CallSplit'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import PhotoGrid from '../components/PhotoGrid'
import PhotoViewer from '../components/PhotoViewer'
import { api, personFaceUrl, thumbUrl } from '../api/client'
import type { MediaItem, Person } from '../api/types'

export default function PersonPage(): JSX.Element {
  const { id } = useParams()
  const personId = Number(id)
  const navigate = useNavigate()
  const [items, setItems] = useState<MediaItem[]>([])
  const [name, setName] = useState('')
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const [exporting, setExporting] = useState(false)
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  const [chooser, setChooser] = useState(false)
  // Bumped after changing the cover so the <img> re-fetches (same URL).
  const [coverBust, setCoverBust] = useState(0)
  const [fixMode, setFixMode] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [splitting, setSplitting] = useState(false)

  const load = useCallback(() => {
    api.personMedia(personId).then((r) => setItems(r.items))
  }, [personId])

  useEffect(() => {
    load()
    api.people(true).then((r) => {
      const p = r.people.find((x: Person) => x.id === personId)
      setName(p?.name ?? '')
    })
  }, [personId, load])

  const save = async (): Promise<void> => {
    await api.renamePerson(personId, name.trim() || null)
  }
  const hide = async (): Promise<void> => {
    await api.hidePerson(personId, true)
    navigate('/people')
  }

  const exitFix = (): void => {
    setFixMode(false)
    setSelected(new Set())
  }
  const toggleSelect = (id: number): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  // Move the selected (wrongly-grouped) photos out into a new person.
  const doSplit = async (): Promise<void> => {
    if (selected.size === 0) return
    setSplitting(true)
    try {
      const r = await api.splitPerson(personId, [...selected])
      exitFix()
      load()
      if (r.new_person_id) {
        setToast({ msg: `Moved ${selected.size} photo(s) to a new person`, ok: true })
        navigate(`/people/${r.new_person_id}`)
      }
    } finally {
      setSplitting(false)
    }
  }

  const chooseCover = async (mediaId: number): Promise<void> => {
    const r = await api.setPersonCover(personId, mediaId)
    if (r.ok) {
      setCoverBust((n) => n + 1)
      setChooser(false)
    } else {
      setToast({ msg: 'Could not set that photo as the thumbnail', ok: false })
    }
  }

  const exportPhotos = async (): Promise<void> => {
    const dest = await window.memora?.pickExportDir()
    if (!dest) return
    setExporting(true)
    try {
      const r = await api.exportPerson(personId, dest)
      setToast({
        msg: `Exported ${r.exported} photo${r.exported === 1 ? '' : 's'} to ${r.dest}${
          r.skipped ? ` (${r.skipped} skipped)` : ''
        }`,
        ok: true
      })
    } catch (e) {
      setToast({ msg: `Export failed: ${e}`, ok: false })
    } finally {
      setExporting(false)
    }
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box
        sx={{
          px: 2.5,
          py: 1.5,
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          borderBottom: (t) => `1px solid ${t.palette.divider}`
        }}
      >
        <IconButton onClick={() => navigate('/people')}>
          <ArrowBackIcon />
        </IconButton>
        <Tooltip title="Change thumbnail">
          <Badge
            overlap="circular"
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            badgeContent={<EditIcon sx={{ fontSize: 14 }} />}
            sx={{ cursor: 'pointer', '& .MuiBadge-badge': { p: 0.3, bgcolor: 'background.paper', borderRadius: '50%' } }}
          >
            <Avatar
              src={`${personFaceUrl(personId)}?v=${coverBust}`}
              onClick={() => items.length > 0 && setChooser(true)}
              sx={{ width: 44, height: 44 }}
            />
          </Badge>
        </Tooltip>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 1 }}>
          <TextField
            size="small"
            placeholder="Add a name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
          <Button onClick={save} variant="contained" size="small">
            Save
          </Button>
        </Stack>
        {fixMode ? (
          <>
            <Button
              variant="contained"
              color="warning"
              size="small"
              startIcon={<CallSplitIcon />}
              disabled={selected.size === 0 || splitting}
              onClick={doSplit}
            >
              {splitting ? 'Moving…' : `Move ${selected.size || ''} to new person`}
            </Button>
            <Button variant="outlined" size="small" onClick={exitFix} disabled={splitting}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Tooltip title="Move wrongly-grouped photos to a new person">
              <Button
                onClick={() => setFixMode(true)}
                variant="outlined"
                size="small"
                startIcon={<CallSplitIcon />}
                disabled={items.length === 0}
              >
                Fix grouping
              </Button>
            </Tooltip>
            <Button
              onClick={exportPhotos}
              disabled={exporting}
              variant="outlined"
              size="small"
              startIcon={
                exporting ? <CircularProgress size={16} /> : <DriveFileMoveIcon />
              }
            >
              {exporting ? 'Exporting…' : 'Export'}
            </Button>
            <Tooltip title="Hide this person">
              <IconButton onClick={hide}>
                <VisibilityOffIcon />
              </IconButton>
            </Tooltip>
          </>
        )}
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflow: fixMode ? 'auto' : 'hidden' }}>
        {fixMode ? (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
              gap: 1,
              p: 2
            }}
          >
            {items.map((it) => {
              const isSel = selected.has(it.id)
              return (
                <Box
                  key={it.id}
                  onClick={() => toggleSelect(it.id)}
                  sx={{
                    position: 'relative',
                    aspectRatio: '1 / 1',
                    borderRadius: 2,
                    overflow: 'hidden',
                    cursor: 'pointer',
                    outline: (t) =>
                      isSel ? `3px solid ${t.palette.warning.main}` : 'none'
                  }}
                >
                  <img
                    src={thumbUrl(it.id)}
                    alt={it.filename}
                    loading="lazy"
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      display: 'block',
                      opacity: isSel ? 0.7 : 1
                    }}
                  />
                  {isSel && (
                    <CheckCircleIcon
                      color="warning"
                      sx={{
                        position: 'absolute',
                        top: 4,
                        right: 4,
                        bgcolor: 'background.paper',
                        borderRadius: '50%'
                      }}
                    />
                  )}
                </Box>
              )
            })}
          </Box>
        ) : (
          <PhotoGrid items={items} grouping="month" onOpen={setViewerIndex} />
        )}
      </Box>
      {viewerIndex !== null && (
        <PhotoViewer
          items={items}
          index={viewerIndex}
          onClose={() => setViewerIndex(null)}
          onIndexChange={setViewerIndex}
          onMutate={load}
        />
      )}
      <Dialog open={chooser} onClose={() => setChooser(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Choose thumbnail</DialogTitle>
        <DialogContent dividers>
          <ImageList cols={4} gap={8} sx={{ m: 0 }}>
            {items.map((it) => (
              <ImageListItem
                key={it.id}
                onClick={() => chooseCover(it.id)}
                sx={{
                  cursor: 'pointer',
                  borderRadius: 2,
                  overflow: 'hidden',
                  '&:hover': { outline: (t) => `2px solid ${t.palette.primary.main}` }
                }}
              >
                <img
                  src={personFaceUrl(personId, it.id)}
                  alt={it.filename}
                  loading="lazy"
                  style={{ aspectRatio: '1 / 1', objectFit: 'cover' }}
                />
              </ImageListItem>
            ))}
          </ImageList>
        </DialogContent>
      </Dialog>

      <Snackbar
        open={!!toast}
        autoHideDuration={6000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {toast ? (
          <Alert severity={toast.ok ? 'success' : 'error'} onClose={() => setToast(null)}>
            {toast.msg}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  )
}
