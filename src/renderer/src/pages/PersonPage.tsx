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
  CircularProgress
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import DriveFileMoveIcon from '@mui/icons-material/DriveFileMove'
import PhotoGrid from '../components/PhotoGrid'
import PhotoViewer from '../components/PhotoViewer'
import { api } from '../api/client'
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
      </Box>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <PhotoGrid items={items} grouping="month" onOpen={setViewerIndex} />
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
