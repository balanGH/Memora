import { useCallback, useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Box,
  IconButton,
  Typography,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  CircularProgress
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import AddPhotoAlternateIcon from '@mui/icons-material/AddPhotoAlternate'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import PhotoGrid from '../components/PhotoGrid'
import PhotoViewer from '../components/PhotoViewer'
import { api, thumbUrl } from '../api/client'
import type { Album, MediaItem } from '../api/types'

export default function AlbumPage(): JSX.Element {
  const { id } = useParams()
  const albumId = Number(id)
  const navigate = useNavigate()
  const [items, setItems] = useState<MediaItem[]>([])
  const [album, setAlbum] = useState<Album | null>(null)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)

  // add-photos picker
  const [picker, setPicker] = useState(false)
  const [library, setLibrary] = useState<MediaItem[]>([])
  const [libLoading, setLibLoading] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    api.albumMedia(albumId).then((r) => setItems(r.items))
    api.albums().then((r) => setAlbum(r.albums.find((a) => a.id === albumId) ?? null))
  }, [albumId])
  useEffect(load, [load])

  const openPicker = (): void => {
    setSelected(new Set())
    setPicker(true)
    if (library.length === 0) {
      setLibLoading(true)
      api
        .media('photos', 'newest', 1000, 0)
        .then((r) => setLibrary(r.items))
        .finally(() => setLibLoading(false))
    }
  }

  const toggle = (mid: number): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(mid) ? next.delete(mid) : next.add(mid)
      return next
    })
  }

  const addSelected = async (): Promise<void> => {
    if (selected.size === 0) return
    setSaving(true)
    try {
      await api.addToAlbum(albumId, [...selected])
      setPicker(false)
      load()
    } finally {
      setSaving(false)
    }
  }

  const inAlbum = new Set(items.map((i) => i.id))

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
        <IconButton onClick={() => navigate('/albums')}>
          <ArrowBackIcon />
        </IconButton>
        <Typography variant="h6" sx={{ flex: 1 }}>
          {album?.name ?? 'Album'}
        </Typography>
        <Button
          variant="contained"
          startIcon={<AddPhotoAlternateIcon />}
          onClick={openPicker}
        >
          Add photos
        </Button>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0 }}>
        {items.length === 0 ? (
          <Box
            sx={{
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'text.secondary',
              gap: 1
            }}
          >
            <Typography variant="h6">This album is empty</Typography>
            <Button
              variant="outlined"
              startIcon={<AddPhotoAlternateIcon />}
              onClick={openPicker}
            >
              Add photos
            </Button>
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

      {/* Add-photos picker */}
      <Dialog open={picker} onClose={() => setPicker(false)} maxWidth="md" fullWidth>
        <DialogTitle>Add photos to {album?.name ?? 'album'}</DialogTitle>
        <DialogContent dividers sx={{ minHeight: 320 }}>
          {libLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
              <CircularProgress />
            </Box>
          ) : (
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
                gap: 1
              }}
            >
              {library.map((m) => {
                const already = inAlbum.has(m.id)
                const isSel = selected.has(m.id)
                return (
                  <Box
                    key={m.id}
                    onClick={() => !already && toggle(m.id)}
                    sx={{
                      position: 'relative',
                      aspectRatio: '1 / 1',
                      borderRadius: 2,
                      overflow: 'hidden',
                      cursor: already ? 'default' : 'pointer',
                      outline: (t) =>
                        isSel ? `3px solid ${t.palette.primary.main}` : 'none'
                    }}
                  >
                    <img
                      src={thumbUrl(m.id)}
                      alt={m.filename}
                      loading="lazy"
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        display: 'block',
                        opacity: already ? 0.4 : isSel ? 0.75 : 1
                      }}
                    />
                    {already && (
                      <Typography
                        variant="caption"
                        sx={{
                          position: 'absolute',
                          inset: 0,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: '#fff',
                          fontWeight: 600,
                          textShadow: '0 1px 3px rgba(0,0,0,0.8)'
                        }}
                      >
                        In album
                      </Typography>
                    )}
                    {isSel && (
                      <CheckCircleIcon
                        color="primary"
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
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPicker(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={addSelected}
            disabled={selected.size === 0 || saving}
          >
            {saving ? 'Adding…' : `Add ${selected.size || ''}`}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
