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
import MemoryIcon from '@mui/icons-material/Memory'
import { api } from '../api/client'
import { useScanStatus } from '../hooks/useScanStatus'
import type { Folder, SystemInfo } from '../api/types'

export default function SettingsPage(): JSX.Element {
  const [folders, setFolders] = useState<Folder[]>([])
  const [error, setError] = useState<string | null>(null)
  const [tileCache, setTileCache] = useState<{ tiles: number; bytes: number } | null>(null)
  const status = useScanStatus()
  const [system, setSystem] = useState<SystemInfo | null>(null)

  // Re-read after an AI run starts/stops: models load lazily, so the active
  // backend and its real providers are only known once processing has begun.
  const aiRunning = status?.ai.running
  useEffect(() => {
    api.system().then(setSystem).catch(() => setSystem(null))
  }, [aiRunning])

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
        <ComputeStatus system={system} />
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

const DEVICE_LABEL: Record<SystemInfo['device'], string> = {
  cuda: 'NVIDIA CUDA',
  directml: 'DirectML',
  coreml: 'Apple CoreML',
  cpu: 'CPU'
}

/** Shows which GPU was detected and whether the AI backend is using it. */
function ComputeStatus({ system }: { system: SystemInfo | null }): JSX.Element {
  if (!system) {
    return <Chip size="small" variant="outlined" label="Detecting hardware…" />
  }
  const gpuNames = system.gpus.map((g) => g.name).join(', ') || 'No GPU detected'
  const backend =
    system.active_backend === 'insightface'
      ? 'InsightFace faces'
      : system.active_backend === 'stub'
        ? 'Stub AI (deterministic)'
        : system.insightface_installed
          ? 'InsightFace (loads on first run)'
          : 'Stub AI (deterministic)'
  // Requested a GPU provider but onnxruntime fell back to CPU at load time.
  const fellBack =
    system.active_backend === 'insightface' && system.is_gpu && !system.gpu_in_use

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Chip
          size="small"
          icon={<MemoryIcon />}
          color={system.is_gpu && !fellBack ? 'success' : 'default'}
          variant="outlined"
          label={`Compute: ${DEVICE_LABEL[system.device]}${fellBack ? ' (fell back to CPU)' : ''}`}
        />
        <Chip size="small" variant="outlined" label={gpuNames} />
        <Chip size="small" variant="outlined" label={backend} />
      </Stack>
      {system.recommended_package && (
        <Alert severity="info" variant="outlined">
          A GPU was found but isn&apos;t being used. Install{' '}
          <code>{system.recommended_package}</code> in the backend environment (or run{' '}
          <code>npm run backend:install-ai</code>) and restart Memora to speed up AI
          processing.
        </Alert>
      )}
    </Stack>
  )
}
