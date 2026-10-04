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
  Stack,
  Avatar,
  TextField,
  Button,
  CircularProgress
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import LibraryAddIcon from '@mui/icons-material/LibraryAdd'
import UnarchiveIcon from '@mui/icons-material/Unarchive'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import VisibilityIcon from '@mui/icons-material/Visibility'
import RestoreFromTrashIcon from '@mui/icons-material/RestoreFromTrash'
import AutoAwesomeMosaicIcon from '@mui/icons-material/AutoAwesomeMosaic'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import { useNavigate } from 'react-router-dom'
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
import { api, displayUrl, fileUrl, personFaceUrl, thumbUrl } from '../api/client'
import type { LibraryView, MediaFlag, MediaItem, MediaDetail } from '../api/types'
import { useMediaActions } from '../hooks/useMediaActions'
import AlbumPickerMenu from './AlbumPickerMenu'

/** True when a keystroke is meant for a text field, not a viewer shortcut. */
function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
}

interface Props {
  items: MediaItem[]
  index: number
  onClose: () => void
  onIndexChange: (i: number) => void
  onMutate?: () => void
  /** Library bucket being browsed; flips archive / hide / trash into undo actions. */
  view?: LibraryView
}

export default function PhotoViewer({
  items,
  index,
  onClose,
  onIndexChange,
  onMutate,
  view
}: Props): JSX.Element {
  // A photo opened from the Similar strip temporarily replaces the current one.
  const [override, setOverride] = useState<MediaItem | null>(null)
  const item = override ?? items[index]
  const navigate = useNavigate()
  const [detail, setDetail] = useState<MediaDetail | null>(null)
  const [showInfo, setShowInfo] = useState(false)
  const [tagInput, setTagInput] = useState('')
  const [albumAnchor, setAlbumAnchor] = useState<null | HTMLElement>(null)
  const [showSimilar, setShowSimilar] = useState(false)
  const [similar, setSimilar] = useState<MediaItem[] | null>(null)
  const { setFlag } = useMediaActions(onMutate)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const dragging = useRef<{ x: number; y: number } | null>(null)

  const reset = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  // Jump from a face in this photo to that person's full set of photos.
  const goToPerson = useCallback(
    (personId: number) => {
      onClose()
      navigate(`/people/${personId}`)
    },
    [navigate, onClose]
  )

  // AI tags can be wrong (e.g. a group photo tagged "beach") — let the user
  // correct them. Updates run against the local detail state so the panel
  // reflects the change without a reload.
  const addTag = useCallback(async () => {
    const label = tagInput.trim()
    if (!label || !item) return
    const { tag } = await api.addTag(item.id, label)
    setTagInput('')
    setDetail((d) =>
      d && !d.tags.some((t) => t.id === tag.id)
        ? { ...d, tags: [...d.tags, tag] }
        : d
    )
  }, [tagInput, item])

  const removeTag = useCallback(
    async (tagId: number) => {
      if (!item) return
      await api.deleteTag(item.id, tagId)
      setDetail((d) => (d ? { ...d, tags: d.tags.filter((t) => t.id !== tagId) } : d))
    },
    [item]
  )

  // Keep the index valid when the list shrinks (e.g. after trashing a photo the
  // next one slides into place); close when nothing is left.
  useEffect(() => {
    if (override) return
    if (items.length === 0) onClose()
    else if (index >= items.length) onIndexChange(items.length - 1)
  }, [items.length, index, override, onClose, onIndexChange])

  // Similar photos are fetched lazily when the strip is open.
  useEffect(() => {
    setSimilar(null)
    if (showSimilar && item) {
      api.similar(item.id).then((r) => setSimilar(r.items)).catch(() => setSimilar([]))
    }
  }, [showSimilar, item?.id])

  useEffect(() => {
    reset()
    setTagInput('')
    if (item) api.mediaDetail(item.id).then(setDetail).catch(() => setDetail(null))
  }, [item?.id, reset])

  const prev = useCallback(() => {
    if (override) return setOverride(null)
    if (index > 0) onIndexChange(index - 1)
  }, [index, onIndexChange, override])
  const next = useCallback(() => {
    if (override) return setOverride(null)
    if (index < items.length - 1) onIndexChange(index + 1)
  }, [index, items.length, onIndexChange, override])

  const toggleFlag = useCallback(
    async (flag: MediaFlag) => {
      if (!item) return
      const current =
        flag === 'is_favorite'
          ? item.is_favorite
          : flag === 'is_archived'
            ? (item.is_archived ?? view === 'archive')
            : flag === 'is_hidden'
              ? (item.is_hidden ?? view === 'hidden')
              : view === 'trash'
      await setFlag([item.id], flag, !current)
      if (flag === 'is_favorite') {
        setDetail((d) => (d ? { ...d, is_favorite: !current } : d))
        if (override) setOverride({ ...override, is_favorite: !current })
      } else if (override) {
        setOverride(null)
      }
    },
    [item, view, setFlag, override]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return
      switch (e.key) {
        case 'Escape':
          if (override) setOverride(null)
          else onClose()
          break
        case 'Delete':
          toggleFlag('is_trashed')
          break
        case 'e':
          toggleFlag('is_archived')
          break
        case 's':
          setShowSimilar((v) => !v)
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
  }, [prev, next, onClose, toggleFlag, reset, override])

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
          {override ? (
            <Tooltip title="Back (Esc)">
              <IconButton onClick={() => setOverride(null)} sx={{ color: '#fff' }} aria-label="Back to previous photo">
                <ArrowBackIcon />
              </IconButton>
            </Tooltip>
          ) : (
            <IconButton onClick={onClose} sx={{ color: '#fff' }} aria-label="Close viewer">
              <CloseIcon />
            </IconButton>
          )}
          <Typography sx={{ opacity: 0.8, flex: 1 }} noWrap>
            {override ? `Similar · ${item.filename}` : item.filename}
          </Typography>
          {view === 'trash' && !override ? (
            <Button
              startIcon={<RestoreFromTrashIcon />}
              variant="contained"
              onClick={() => toggleFlag('is_trashed')}
            >
              Restore
            </Button>
          ) : (
            <>
              <ViewerButton
                title={item.is_favorite ? 'Remove from favorites (f)' : 'Add to favorites (f)'}
                onClick={() => toggleFlag('is_favorite')}
              >
                {item.is_favorite ? <FavoriteIcon color="error" /> : <FavoriteBorderIcon />}
              </ViewerButton>
              <ViewerButton title="Add to album" onClick={(e) => setAlbumAnchor(e.currentTarget)}>
                <LibraryAddIcon />
              </ViewerButton>
              <ViewerButton
                title={view === 'archive' ? 'Unarchive (e)' : 'Archive (e)'}
                onClick={() => toggleFlag('is_archived')}
              >
                {view === 'archive' ? <UnarchiveIcon /> : <ArchiveIcon />}
              </ViewerButton>
              <ViewerButton
                title={view === 'hidden' ? 'Unhide' : 'Hide'}
                onClick={() => toggleFlag('is_hidden')}
              >
                {view === 'hidden' ? <VisibilityIcon /> : <VisibilityOffIcon />}
              </ViewerButton>
              <ViewerButton title="Move to trash (Delete)" onClick={() => toggleFlag('is_trashed')}>
                <DeleteIcon />
              </ViewerButton>
            </>
          )}
          <ViewerButton title="Zoom out (-)" onClick={() => setZoom((z) => Math.max(z - 0.25, 1))}>
            <ZoomOutIcon />
          </ViewerButton>
          <ViewerButton title="Zoom in (+)" onClick={() => setZoom((z) => Math.min(z + 0.25, 5))}>
            <ZoomInIcon />
          </ViewerButton>
          <ViewerButton
            title="Similar photos (s)"
            onClick={() => setShowSimilar((v) => !v)}
            active={showSimilar}
          >
            <AutoAwesomeMosaicIcon />
          </ViewerButton>
          <ViewerButton title="Info (i)" onClick={() => setShowInfo((s) => !s)} active={showInfo}>
            <InfoOutlinedIcon />
          </ViewerButton>
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
          {!override && index > 0 && (
            <IconButton
              onClick={prev}
              aria-label="Previous photo"
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
                alt={`${item.filename}${item.taken_at ? `, taken ${new Date(item.taken_at).toLocaleDateString()}` : ''}`}
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
          {!override && index < items.length - 1 && (
            <IconButton
              onClick={next}
              aria-label="Next photo"
              sx={{ position: 'absolute', right: 12, top: '50%', color: '#fff', zIndex: 2 }}
            >
              <ChevronRightIcon fontSize="large" />
            </IconButton>
          )}
        </Box>

        {showSimilar && (
          <Box
            role="region"
            aria-label="Similar photos"
            sx={{
              height: 116,
              px: 2,
              pb: 1.5,
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              overflowX: 'auto',
              color: '#fff'
            }}
          >
            {similar === null ? (
              <CircularProgress size={24} sx={{ color: '#fff', mx: 'auto' }} />
            ) : similar.length === 0 ? (
              <Typography variant="body2" sx={{ opacity: 0.7, mx: 'auto' }}>
                No similar photos yet. They appear once AI processing has run.
              </Typography>
            ) : (
              similar.map((m) => (
                <Box
                  key={m.id}
                  component="button"
                  onClick={() => setOverride(m)}
                  aria-label={`Open similar photo ${m.filename}`}
                  sx={{
                    flexShrink: 0,
                    p: 0,
                    border: 0,
                    borderRadius: 1.5,
                    overflow: 'hidden',
                    cursor: 'pointer',
                    outline: m.id === item.id ? '2px solid #8ab4f8' : 'none',
                    '&:focus-visible': { outline: '2px solid #8ab4f8' },
                    opacity: 0.85,
                    '&:hover': { opacity: 1 }
                  }}
                >
                  <img
                    src={thumbUrl(m.id)}
                    alt=""
                    loading="lazy"
                    style={{ height: 100, width: 'auto', display: 'block' }}
                  />
                </Box>
              ))
            )}
          </Box>
        )}

        {/* info drawer — force above the fullscreen viewer Modal (default
            Drawer z-index sits below it, which hid the panel entirely). */}
        <Drawer
          anchor="right"
          open={showInfo}
          onClose={() => setShowInfo(false)}
          sx={{ zIndex: (t) => t.zIndex.modal + 2 }}
        >
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
                    <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mt: 1 }}>
                      {detail.people.map((p) => (
                        <Box
                          key={p.id}
                          onClick={() => goToPerson(p.id)}
                          role="button"
                          title={`See all photos of ${p.name ?? 'this person'}`}
                          sx={{
                            width: 72,
                            cursor: 'pointer',
                            textAlign: 'center',
                            '&:hover .memora-face': {
                              boxShadow: (t) => `0 0 0 2px ${t.palette.primary.main}`
                            }
                          }}
                        >
                          <Avatar
                            className="memora-face"
                            src={personFaceUrl(p.id)}
                            imgProps={{
                              // Fall back to the full photo's thumbnail if there's
                              // no cropped face for this person yet.
                              onError: (e) => {
                                const img = e.currentTarget
                                if (!img.dataset.fallback) {
                                  img.dataset.fallback = '1'
                                  img.src = thumbUrl(item.id)
                                }
                              }
                            }}
                            sx={{ width: 56, height: 56, mx: 'auto', mb: 0.5 }}
                          />
                          <Typography variant="caption" noWrap sx={{ display: 'block' }}>
                            {p.name ?? 'Unnamed'}
                          </Typography>
                        </Box>
                      ))}
                    </Box>
                  </Box>
                )}
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Tags
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.5, mb: 1 }}>
                    {detail.tags.filter((t) => t.kind !== 'ocr').length === 0 && (
                      <Typography variant="body2" color="text.secondary">
                        No tags yet
                      </Typography>
                    )}
                    {detail.tags
                      .filter((t) => t.kind !== 'ocr')
                      .map((t) => (
                        <Chip
                          key={t.id}
                          label={t.label}
                          size="small"
                          variant="outlined"
                          onDelete={() => removeTag(t.id)}
                        />
                      ))}
                  </Box>
                  <Box sx={{ display: 'flex', gap: 1 }}>
                    <TextField
                      size="small"
                      placeholder="Add a tag"
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          addTag()
                        }
                      }}
                      fullWidth
                    />
                    <IconButton
                      onClick={addTag}
                      disabled={!tagInput.trim()}
                      size="small"
                      aria-label="Add tag"
                    >
                      <AddIcon />
                    </IconButton>
                  </Box>
                </Box>
              </Stack>
            )}
          </Box>
        </Drawer>

        <AlbumPickerMenu
          anchorEl={albumAnchor}
          onClose={() => setAlbumAnchor(null)}
          mediaIds={[item.id]}
          overModal
        />
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

function ViewerButton({
  title,
  onClick,
  children,
  active
}: {
  title: string
  onClick: (e: React.MouseEvent<HTMLElement>) => void
  children: React.ReactNode
  active?: boolean
}): JSX.Element {
  return (
    <Tooltip title={title}>
      <IconButton
        onClick={onClick}
        aria-label={title}
        aria-pressed={active}
        sx={{ color: active ? '#8ab4f8' : '#fff' }}
      >
        {children}
      </IconButton>
    </Tooltip>
  )
}
