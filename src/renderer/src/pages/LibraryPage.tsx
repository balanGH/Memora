import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  MenuItem,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import LockIcon from '@mui/icons-material/Lock'
import RestoreFromTrashIcon from '@mui/icons-material/RestoreFromTrash'
import DeleteForeverIcon from '@mui/icons-material/DeleteForever'
import PhotoGrid, { type GridAction, type PhotoGridHandle } from '../components/PhotoGrid'
import PhotoViewer from '../components/PhotoViewer'
import SelectionBar from '../components/SelectionBar'
import TimelineScrubber from '../components/TimelineScrubber'
import { api, emitLibraryChanged, LIBRARY_CHANGED } from '../api/client'
import { refreshScanStatus, useScanStatus } from '../hooks/useScanStatus'
import { useMediaActions } from '../hooks/useMediaActions'
import { useNotify } from '../context/FeedbackContext'
import type { LibraryView, MediaItem, SortKey, TimelineMonth } from '../api/types'
import type { Grouping } from '../components/dateGroups'

const PAGE = 200

const TITLES: Record<LibraryView, string> = {
  photos: 'Photos',
  favorites: 'Favorites',
  archive: 'Archive',
  hidden: 'Hidden',
  trash: 'Trash'
}

const EMPTY_TEXT: Record<LibraryView, [string, string]> = {
  photos: ['No photos yet', 'Photos from your library folders will appear here.'],
  favorites: ['No favorites yet', 'Press F or tap the heart on a photo to add it here.'],
  archive: ['Archive is empty', 'Archived photos are hidden from Photos but stay searchable.'],
  hidden: ['Nothing hidden', 'Hidden photos only appear here.'],
  trash: ['Trash is empty', 'Photos you move to the trash appear here until you empty it.']
}

export default function LibraryPage({ view }: { view: LibraryView }): JSX.Element {
  const [items, setItems] = useState<MediaItem[]>([])
  const [sort, setSort] = useState<SortKey>('newest')
  const [grouping, setGrouping] = useState<Grouping>('day')
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  const [folderCount, setFolderCount] = useState<number | null>(null)
  const [months, setMonths] = useState<TimelineMonth[]>([])
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  const offset = useRef(0)
  const total = useRef(0)
  const inflight = useRef<Promise<void> | null>(null)
  const pendingScroll = useRef<number | null>(null)
  const grid = useRef<PhotoGridHandle>(null)
  const scan = useScanStatus()
  const wasBusy = useRef(false)
  const notify = useNotify()
  const busy = !!(scan?.scan.running || scan?.ai.running)
  const timelineSort = sort === 'newest' || sort === 'oldest'

  const load = useCallback(
    (reset: boolean): Promise<void> => {
      if (inflight.current) return inflight.current
      const nextOffset = reset ? 0 : offset.current
      const p = (async () => {
        try {
          const page = await api.media(view, sort, PAGE, nextOffset)
          total.current = page.total
          offset.current = nextOffset + page.items.length
          setItems((prev) => (reset ? page.items : [...prev, ...page.items]))
        } finally {
          inflight.current = null
          setLoading(false)
        }
      })()
      inflight.current = p
      return p
    },
    [view, sort]
  )

  /** Re-fetch everything loaded so far, keeping the scroll position. */
  const refresh = useCallback(async () => {
    const n = Math.max(offset.current, PAGE)
    const page = await api.media(view, sort, n, 0)
    total.current = page.total
    offset.current = page.items.length
    setItems(page.items)
  }, [view, sort])

  const loadMonths = useCallback(() => {
    if (!timelineSort) return setMonths([])
    api.timeline(view, sort).then((r) => setMonths(r.months)).catch(() => setMonths([]))
  }, [view, sort, timelineSort])

  useEffect(() => {
    offset.current = 0
    total.current = 0
    setItems([])
    setSelected(new Set())
    setLoading(true)
    load(true)
    loadMonths()
  }, [view, sort, load, loadMonths])

  useEffect(() => {
    api.folders().then((r) => setFolderCount(r.folders.length)).catch(() => {})
  }, [])

  // Pick up changes made elsewhere (viewer, other pages, bulk actions).
  useEffect(() => {
    const onChange = (): void => {
      refresh()
      loadMonths()
    }
    window.addEventListener(LIBRARY_CHANGED, onChange)
    return () => window.removeEventListener(LIBRARY_CHANGED, onChange)
  }, [refresh, loadMonths])

  // Auto-refresh when a scan or AI pass finishes, so newly indexed photos
  // appear without needing to switch tabs and back.
  useEffect(() => {
    if (wasBusy.current && !busy) {
      refresh()
      loadMonths()
      api.folders().then((r) => setFolderCount(r.folders.length)).catch(() => {})
    }
    wasBusy.current = busy
  }, [busy, refresh, loadMonths])

  const onEndReached = useCallback(() => {
    if (offset.current < total.current) load(false)
  }, [load])

  // Timeline jump: page in everything up to the target, then scroll to it.
  const jump = useCallback(
    async (target: number) => {
      pendingScroll.current = target
      while (offset.current <= target && offset.current < total.current) {
        await load(false)
      }
      if (offset.current > target) {
        grid.current?.scrollToItem(target)
        pendingScroll.current = null
      }
    },
    [load]
  )
  useEffect(() => {
    const t = pendingScroll.current
    if (t !== null && items.length > t) {
      grid.current?.scrollToItem(t)
      pendingScroll.current = null
    }
  }, [items])

  // Library changes broadcast LIBRARY_CHANGED, which already triggers refresh().
  const { setFlag } = useMediaActions()

  const onAction = useCallback(
    (action: GridAction, ids: number[]) => {
      const chosen = items.filter((i) => ids.includes(i.id))
      if (action === 'favorite') {
        setFlag(ids, 'is_favorite', !chosen.every((i) => i.is_favorite))
      } else if (action === 'archive') {
        setFlag(ids, 'is_archived', view !== 'archive')
        setSelected(new Set())
      } else if (action === 'trash') {
        setFlag(ids, 'is_trashed', view !== 'trash')
        setSelected(new Set())
      }
    },
    [items, setFlag, view]
  )

  const addFolders = async (): Promise<void> => {
    const paths = (await window.memora?.pickFolders()) ?? []
    if (!paths.length) return
    for (const p of paths) await api.addFolder(p)
    setFolderCount((n) => (n ?? 0) + paths.length)
    await api.scan()
    refreshScanStatus()
    notify('Scanning your photos… they will appear as they are indexed', { severity: 'info' })
  }

  const restoreAll = async (): Promise<void> => {
    const r = await api.restoreTrash()
    emitLibraryChanged()
    notify(`Restored ${r.restored} item(s)`)
  }

  const emptyTrash = async (): Promise<void> => {
    setConfirmEmpty(false)
    const r = await api.emptyTrash()
    emitLibraryChanged()
    notify(`Removed ${r.removed} item(s) from the library`, { severity: 'info' })
  }

  let emptyState: ReactNode
  if (view === 'photos' && folderCount === 0) {
    emptyState = <Onboarding onAddFolder={addFolders} />
  } else if (view === 'photos' && busy) {
    emptyState = (
      <EmptyMessage title="Scanning your folders…" text="Photos appear here as they are indexed." />
    )
  } else {
    const [title, text] = EMPTY_TEXT[view]
    emptyState = <EmptyMessage title={title} text={text} />
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {selected.size > 0 ? (
        <SelectionBar
          items={items}
          selected={selected}
          onChange={setSelected}
          view={view}
        />
      ) : (
        <Box
          sx={{
            px: 2.5,
            py: 1.5,
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            borderBottom: (t) => `1px solid ${t.palette.divider}`
          }}
        >
          <Typography component="h1" sx={{ fontSize: 20, fontWeight: 600 }}>
            {TITLES[view]}
          </Typography>
          {total.current > 0 && (
            <Typography variant="body2" color="text.secondary">
              {total.current.toLocaleString()} items
            </Typography>
          )}
          <Box sx={{ flex: 1 }} />
          {view === 'trash' && items.length > 0 && (
            <>
              <Button startIcon={<RestoreFromTrashIcon />} onClick={restoreAll}>
                Restore all
              </Button>
              <Button
                color="error"
                startIcon={<DeleteForeverIcon />}
                onClick={() => setConfirmEmpty(true)}
              >
                Empty trash
              </Button>
            </>
          )}
          <ToggleButtonGroup
            size="small"
            exclusive
            value={grouping}
            onChange={(_, v) => v && setGrouping(v)}
            aria-label="Group by"
          >
            <ToggleButton value="day">Day</ToggleButton>
            <ToggleButton value="month">Month</ToggleButton>
            <ToggleButton value="year">Year</ToggleButton>
          </ToggleButtonGroup>
          <TextField
            select
            size="small"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            sx={{ minWidth: 150 }}
            inputProps={{ 'aria-label': 'Sort order' }}
          >
            <MenuItem value="newest">Newest first</MenuItem>
            <MenuItem value="oldest">Oldest first</MenuItem>
            <MenuItem value="favorites">Favorites</MenuItem>
            <MenuItem value="added">Recently added</MenuItem>
          </TextField>
        </Box>
      )}

      <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <PhotoGrid
            ref={grid}
            items={items}
            grouping={grouping}
            onOpen={setViewerIndex}
            onEndReached={onEndReached}
            loading={loading}
            emptyState={emptyState}
            selected={selected}
            onSelectedChange={setSelected}
            onAction={onAction}
            ariaLabel={TITLES[view]}
          />
        </Box>
        {timelineSort && items.length > 0 && (
          <TimelineScrubber months={months} onJump={jump} />
        )}
      </Box>

      {viewerIndex !== null && (
        <PhotoViewer
          items={items}
          index={viewerIndex}
          view={view}
          onClose={() => setViewerIndex(null)}
          onIndexChange={setViewerIndex}
        />
      )}

      <Dialog open={confirmEmpty} onClose={() => setConfirmEmpty(false)}>
        <DialogTitle>Empty trash?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {total.current} item(s) will be removed from Memora, along with their faces and
            tags. The original files stay on your disk, and Memora won&apos;t re-import them
            on the next scan. This can&apos;t be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmEmpty(false)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={emptyTrash}>
            Empty trash
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

function EmptyMessage({ title, text }: { title: string; text: string }): JSX.Element {
  return (
    <Box
      sx={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        color: 'text.secondary',
        gap: 0.5,
        px: 3,
        textAlign: 'center'
      }}
    >
      <Typography variant="h6">{title}</Typography>
      <Typography variant="body2">{text}</Typography>
    </Box>
  )
}

/** First-run screen: no library folders yet. */
function Onboarding({ onAddFolder }: { onAddFolder: () => void }): JSX.Element {
  return (
    <Box sx={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 3 }}>
      <Paper variant="outlined" sx={{ p: 4, maxWidth: 520, borderRadius: 4, textAlign: 'center' }}>
        <Box
          sx={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            mx: 'auto',
            mb: 2,
            background: 'linear-gradient(135deg,#4285f4,#a142f4,#ea4335)'
          }}
        />
        <Typography variant="h5" sx={{ fontWeight: 600, mb: 1 }}>
          Welcome to Memora
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Pick the folders where your photos live. Memora indexes them, finds faces and
          places, and makes everything searchable.
        </Typography>
        <Button size="large" variant="contained" startIcon={<FolderOpenIcon />} onClick={onAddFolder}>
          Add a photo folder
        </Button>
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="center" sx={{ mt: 3 }}>
          <LockIcon fontSize="small" color="success" />
          <Typography variant="caption" color="text.secondary">
            Everything stays on this computer. Files are never moved, changed or uploaded.
          </Typography>
        </Stack>
      </Paper>
    </Box>
  )
}
