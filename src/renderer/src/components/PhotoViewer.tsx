import { useCallback, useEffect, useState, useRef } from 'react'
import {
  Box,
  IconButton,
  Modal,
  Tooltip,
  Drawer,
  Typography,
  Divider,
  Chip,
  Stack
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import FavoriteIcon from '@mui/icons-material/Favorite'
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder'
import ArchiveIcon from '@mui/icons-material/Archive'
import DeleteIcon from '@mui/icons-material/Delete'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import ZoomInIcon from '@mui/icons-material/ZoomIn'
import ZoomOutIcon from '@mui/icons-material/ZoomOut'
import PlaceIcon from '@mui/icons-material/Place'
import { api, displayUrl, fileUrl } from '../api/client'
import type { MediaItem, MediaDetail } from '../api/types'

interface Props {
  items: MediaItem[]
  index: number
  onClose: () => void
  onIndexChange: (i: number) => void
  onMutate?: () => void
}

export default function PhotoViewer({
  items,
  index,
  onClose,
  onIndexChange,
  onMutate
}: Props): JSX.Element {
  const item = items[index]
  const [detail, setDetail] = useState<MediaDetail | null>(null)
  const [showInfo, setShowInfo] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const dragging = useRef<{ x: number; y: number } | null>(null)

  const reset = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  useEffect(() => {
    reset()
    if (item) api.mediaDetail(item.id).then(setDetail).catch(() => setDetail(null))
  }, [item?.id, reset])

  const prev = useCallback(() => {
    if (index > 0) onIndexChange(index - 1)
  }, [index, onIndexChange])
  const next = useCallback(() => {
    if (index < items.length - 1) onIndexChange(index + 1)
  }, [index, items.length, onIndexChange])

  const toggleFlag = useCallback(
    async (flag: 'is_favorite' | 'is_archived' | 'is_trashed') => {
      if (!item) return
      const current =
        flag === 'is_favorite'
          ? item.is_favorite
          : flag === 'is_archived'
            ? item.is_archived
            : false
      await api.setFlag(item.id, flag, !current)
      onMutate?.()
      if (flag === 'is_trashed') onClose()
    },
    [item, onMutate, onClose]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      switch (e.key) {
        case 'Escape':
          onClose()
          break
        case 'ArrowLeft':
          prev()
          break
        case 'ArrowRight':
          next()
          break
        case 'i':
          setShowInfo((s) => !s)
          break
        case 'f':
          toggleFlag('is_favorite')
          break
        case '+':
        case '=':
          setZoom((z) => Math.min(z + 0.25, 5))
          break
        case '-':
          setZoom((z) => Math.max(z - 0.25, 1))
          break
        case '0':
          reset()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prev, next, onClose, toggleFlag, reset])

  if (!item) return <></>

  const onWheel = (e: React.WheelEvent): void => {
    const delta = e.deltaY < 0 ? 0.2 : -0.2
    setZoom((z) => Math.min(Math.max(z + delta, 1), 5))
  }

  return (
    <Modal open onClose={onClose}>
      <Box
        sx={{
          position: 'fixed',
          inset: 0,
          bgcolor: 'rgba(0,0,0,0.94)',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        {/* top bar */}
        <Box sx={{ display: 'flex', alignItems: 'center', p: 1.5, gap: 1, color: '#fff' }}>
          <IconButton onClick={onClose} sx={{ color: '#fff' }}>
            <CloseIcon />
          </IconButton>
          <Typography sx={{ opacity: 0.8, flex: 1 }} noWrap>
            {item.filename}
          </Typography>
          <Tooltip title="Favorite (f)">
            <IconButton onClick={() => toggleFlag('is_favorite')} sx={{ color: '#fff' }}>
              {item.is_favorite ? <FavoriteIcon color="error" /> : <FavoriteBorderIcon />}
            </IconButton>
          </Tooltip>
          <Tooltip title="Archive">
            <IconButton onClick={() => toggleFlag('is_archived')} sx={{ color: '#fff' }}>
              <ArchiveIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Move to trash">
            <IconButton onClick={() => toggleFlag('is_trashed')} sx={{ color: '#fff' }}>
              <DeleteIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Zoom out (-)">
            <IconButton onClick={() => setZoom((z) => Math.max(z - 0.25, 1))} sx={{ color: '#fff' }}>
              <ZoomOutIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Zoom in (+)">
            <IconButton onClick={() => setZoom((z) => Math.min(z + 0.25, 5))} sx={{ color: '#fff' }}>
              <ZoomInIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Info (i)">
            <IconButton onClick={() => setShowInfo((s) => !s)} sx={{ color: '#fff' }}>
              <InfoOutlinedIcon />
            </IconButton>
          </Tooltip>
        </Box>

        {/* stage */}
        <Box
          sx={{ flex: 1, position: 'relative', overflow: 'hidden' }}
          onWheel={onWheel}
          onMouseDown={(e) => {
            if (zoom > 1) dragging.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
          }}
          onMouseMove={(e) => {
            if (dragging.current)
              setPan({ x: e.clientX - dragging.current.x, y: e.clientY - dragging.current.y })
          }}
          onMouseUp={() => (dragging.current = null)}
          onMouseLeave={() => (dragging.current = null)}
        >
          {index > 0 && (
            <IconButton
              onClick={prev}
              sx={{ position: 'absolute', left: 12, top: '50%', color: '#fff', zIndex: 2 }}
            >
              <ChevronLeftIcon fontSize="large" />
            </IconButton>
          )}
          <Box
            sx={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            {item.kind === 'video' ? (
              <video
                src={fileUrl(item.id)}
                controls
                autoPlay
                style={{ maxWidth: '100%', maxHeight: '100%', outline: 'none' }}
              />
            ) : (
              <img
                src={displayUrl(item.id)}
                alt={item.filename}
                draggable={false}
                style={{
                  maxWidth: '100%',
                  maxHeight: '100%',
                  objectFit: 'contain',
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transition: dragging.current ? 'none' : 'transform 0.15s ease',
                  cursor: zoom > 1 ? 'grab' : 'default'
                }}
              />
            )}
          </Box>
          {index < items.length - 1 && (
            <IconButton
              onClick={next}
              sx={{ position: 'absolute', right: 12, top: '50%', color: '#fff', zIndex: 2 }}
            >
              <ChevronRightIcon fontSize="large" />
            </IconButton>
          )}
        </Box>

        {/* info drawer */}
        <Drawer anchor="right" open={showInfo} onClose={() => setShowInfo(false)}>
          <Box sx={{ width: 320, p: 2.5 }}>
            <Typography variant="h6" gutterBottom>
              Info
            </Typography>
            <Divider sx={{ mb: 2 }} />
            {detail && (
              <Stack spacing={1.5}>
                <InfoRow label="File" value={detail.filename} />
                <InfoRow
                  label="Taken"
                  value={
                    detail.taken_at ? new Date(detail.taken_at).toLocaleString() : 'Unknown'
                  }
                />
                <InfoRow
                  label="Dimensions"
                  value={detail.width ? `${detail.width} × ${detail.height}` : '—'}
                />
                <InfoRow
                  label="Size"
                  value={
                    detail.size_bytes
                      ? `${(detail.size_bytes / 1024 / 1024).toFixed(2)} MB`
                      : '—'
                  }
                />
                {detail.camera_model && (
                  <InfoRow
                    label="Camera"
                    value={`${detail.camera_make ?? ''} ${detail.camera_model}`.trim()}
                  />
                )}
                {detail.gps_lat != null && detail.gps_lon != null && (
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Location
                    </Typography>
                    <Chip
                      icon={<PlaceIcon />}
                      label={`${detail.gps_lat.toFixed(4)}, ${detail.gps_lon.toFixed(4)}`}
                      size="small"
                      component="a"
                      clickable
                      href={`https://www.openstreetmap.org/?mlat=${detail.gps_lat}&mlon=${detail.gps_lon}#map=15/${detail.gps_lat}/${detail.gps_lon}`}
                      target="_blank"
                    />
                  </Box>
                )}
                {detail.people.length > 0 && (
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      People
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}>
                      {detail.people.map((p) => (
                        <Chip key={p.id} label={p.name ?? 'Unnamed'} size="small" />
                      ))}
                    </Box>
                  </Box>
                )}
                {detail.tags.length > 0 && (
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Tags
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}>
                      {detail.tags
                        .filter((t) => t.kind !== 'ocr')
                        .map((t, i) => (
                          <Chip key={i} label={t.label} size="small" variant="outlined" />
                        ))}
                    </Box>
                  </Box>
                )}
              </Stack>
            )}
          </Box>
        </Drawer>
      </Box>
    </Modal>
  )
}

function InfoRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
        {value}
      </Typography>
    </Box>
  )
}
