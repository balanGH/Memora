import { useCallback, useEffect, useState } from 'react'
import {
  Box,
  Typography,
  Button,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Divider,
  LinearProgress,
  Chip,
  Alert
} from '@mui/material'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import RefreshIcon from '@mui/icons-material/Refresh'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import LockIcon from '@mui/icons-material/Lock'
import MapIcon from '@mui/icons-material/Map'
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep'
import { api } from '../api/client'
import { useScanStatus } from '../hooks/useScanStatus'
import type { Folder } from '../api/types'

export default function SettingsPage(): JSX.Element {
  const [folders, setFolders] = useState<Folder[]>([])
  const [error, setError] = useState<string | null>(null)
  const [tileCache, setTileCache] = useState<{ tiles: number; bytes: number } | null>(null)
  const status = useScanStatus()

  const loadTileStats = useCallback(() => {
    api.tileStats().then(setTileCache).catch(() => setTileCache(null))
  }, [])
  useEffect(loadTileStats, [loadTileStats])

  const clearTiles = async (): Promise<void> => {
    await api.clearTiles()
    loadTileStats()
  }

  const fmtMB = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`

  const loadFolders = useCallback(() => {
    api.folders().then((r) => setFolders(r.folders))
  }, [])
  useEffect(loadFolders, [loadFolders])

  const addFolders = async (): Promise<void> => {
    setError(null)
    try {
      const paths = (await window.memora?.pickFolders()) ?? []
      for (const p of paths) await api.addFolder(p)
      loadFolders()
    } catch (e) {
      setError(String(e))
    }
  }

  const scan = async (): Promise<void> => {
    await api.scan()
  }
  const processAi = async (): Promise<void> => {
    await api.processAi()
  }

  const scanBusy = status?.scan.running
  const aiBusy = status?.ai.running

  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 3, maxWidth: 820 }}>
      <Typography variant="h5" sx={{ fontWeight: 600, mb: 3 }}>
        Settings
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Library folders */}
      <Paper variant="outlined" sx={{ p: 2.5, mb: 3, borderRadius: 3 }}>
        <Stack direction="row" alignItems="center" sx={{ mb: 1.5 }}>
          <Typography variant="h6" sx={{ flex: 1 }}>
            Library folders
          </Typography>
          <Button startIcon={<FolderOpenIcon />} variant="contained" onClick={addFolders}>
            Add folder
          </Button>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Memora indexes photos and videos in these folders. Files are never moved,
          modified, or uploaded.
        </Typography>
        {folders.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
            No folders added yet.
          </Typography>
        ) : (
          <List dense>
            {folders.map((f) => (
              <ListItem key={f.id} disableGutters>
                <ListItemText
                  primary={f.path}
                  secondary={
                    f.last_scan
                      ? `Last scanned ${new Date(f.last_scan).toLocaleString()}`
                      : 'Not scanned yet'
                  }
                />
              </ListItem>
            ))}
          </List>
        )}
      </Paper>

      {/* Indexing + AI */}
      <Paper variant="outlined" sx={{ p: 2.5, mb: 3, borderRadius: 3 }}>
        <Typography variant="h6" sx={{ mb: 1.5 }}>
          Indexing &amp; AI
        </Typography>
        <Stack direction="row" spacing={1.5} sx={{ mb: 2 }}>
          <Button
            startIcon={<RefreshIcon />}
            variant="outlined"
            onClick={scan}
            disabled={scanBusy || folders.length === 0}
          >
            {scanBusy ? 'Scanning…' : 'Scan for new media'}
          </Button>
          <Button
            startIcon={<AutoFixHighIcon />}
            variant="outlined"
            onClick={processAi}
            disabled={aiBusy}
          >
            {aiBusy ? 'Processing…' : 'Run AI processing'}
          </Button>
        </Stack>

        {scanBusy && status && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="caption">
              Scanning {status.scan.processed}/{status.scan.total} — added{' '}
              {status.scan.added}
            </Typography>
            <LinearProgress
              variant="determinate"
              value={status.scan.total ? (status.scan.processed / status.scan.total) * 100 : 0}
            />
          </Box>
        )}
        {aiBusy && status && (
          <Box sx={{ mb: 1 }}>
            <Typography variant="caption">
              AI processing {status.ai.processed}/{status.ai.total} — faces, objects,
              scenes, OCR, embeddings
            </Typography>
            <LinearProgress
              variant="determinate"
              value={status.ai.total ? (status.ai.processed / status.ai.total) * 100 : 0}
            />
          </Box>
        )}
        <Chip
          size="small"
          variant="outlined"
          label="AI models: stubbed (deterministic) — swap in InsightFace / YOLO / CLIP / PaddleOCR later"
        />
      </Paper>

      {/* Map cache */}
      <Paper variant="outlined" sx={{ p: 2.5, mb: 3, borderRadius: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <MapIcon color="primary" />
          <Typography variant="h6" sx={{ flex: 1 }}>
            Map cache
          </Typography>
          <Button
            startIcon={<DeleteSweepIcon />}
            variant="outlined"
            size="small"
            onClick={clearTiles}
            disabled={!tileCache || tileCache.tiles === 0}
          >
            Clear
          </Button>
        </Stack>
        <Typography variant="body2" color="text.secondary">
          The Places map downloads OpenStreetMap tiles the first time you view an area and
          caches them on disk, so revisiting works offline. Only map tiles are fetched — never
          your photos.
        </Typography>
        <Chip
          size="small"
          variant="outlined"
          sx={{ mt: 1.5 }}
          label={
            tileCache
              ? `${tileCache.tiles} tiles cached · ${fmtMB(tileCache.bytes)}`
              : 'Cache size unavailable'
          }
        />
      </Paper>

      {/* Privacy */}
      <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <LockIcon color="success" />
          <Typography variant="h6">Privacy</Typography>
        </Stack>
        <Divider sx={{ mb: 1.5 }} />
        <Typography variant="body2" color="text.secondary">
          Memora is 100% offline. There is no cloud, no telemetry, and no tracking. All
          metadata, thumbnails, and the SQLite database live under a{' '}
          <code>.memora</code> folder in your home directory.
        </Typography>
      </Paper>
    </Box>
  )
}
