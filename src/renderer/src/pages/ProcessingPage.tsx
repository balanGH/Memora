import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Typography
} from '@mui/material'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import PauseIcon from '@mui/icons-material/Pause'
import StopIcon from '@mui/icons-material/Stop'
import ReplayIcon from '@mui/icons-material/Replay'
import RefreshIcon from '@mui/icons-material/Refresh'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import VisibilityIcon from '@mui/icons-material/Visibility'
import { api, emitLibraryChanged } from '../api/client'
import type { FailedMedia, ProcessingSnapshot } from '../api/types'
import { useNotify } from '../context/FeedbackContext'

/** Live view of scanning + AI work, with pause / resume / cancel / retry. */
export default function ProcessingPage(): JSX.Element {
  const [snap, setSnap] = useState<ProcessingSnapshot | null>(null)
  const [failed, setFailed] = useState<FailedMedia[]>([])
  const [error, setError] = useState<string | null>(null)
  const notify = useNotify()
  const navigate = useNavigate()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wasBusy = useRef(false)

  const loadFailed = useCallback(() => {
    api.processingFailed().then((r) => setFailed(r.failed)).catch(() => {})
  }, [])

  // Poll fast while work runs, slowly when idle.
  useEffect(() => {
    let cancelled = false
    const tick = async (): Promise<void> => {
      let busy = false
      try {
        const s = await api.processing()
        if (cancelled) return
        setSnap(s)
        setError(null)
        busy = s.scan.running || s.ai.running
        if (wasBusy.current && !busy) {
          loadFailed()
          emitLibraryChanged()
        }
        wasBusy.current = busy
      } catch (e) {
        if (!cancelled) setError(String(e))
      }
      if (!cancelled) timer.current = setTimeout(tick, busy ? 700 : 3000)
    }
    tick()
    loadFailed()
    return () => {
      cancelled = true
      if (timer.current) clearTimeout(timer.current)
    }
  }, [loadFailed])

  const act = async (action: 'start' | 'pause' | 'resume' | 'cancel' | 'retry'): Promise<void> => {
    const r = await api.processingAction(action)
    if (action === 'retry') {
      notify(r.retried ? `Retrying ${r.retried} failed item(s)` : 'Nothing to retry', {
        severity: r.retried ? 'success' : 'info'
      })
      loadFailed()
    } else if (action === 'start' && !r.ok) {
      notify('Already running, or nothing left to process', { severity: 'info' })
    }
    setSnap(await api.processing())
  }

  if (!snap) {
    return (
      <Box sx={{ p: 3 }}>
        {error ? <Alert severity="error">{error}</Alert> : <LinearProgress />}
      </Box>
    )
  }

  const { ai, scan, stages, watch } = snap
  const pct = (n: number, d: number): number => (d ? Math.round((n / d) * 100) : 0)
  const pending = Math.max(stages.total - stages.ai_processed - stages.failed, 0)

  const STAGES: { label: string; done: number; of: number; hint?: string }[] = [
    { label: 'Thumbnails', done: stages.thumbnails, of: stages.total },
    { label: 'AI analysis', done: stages.ai_processed, of: stages.total },
    { label: 'Duplicate hashing', done: stages.hashed, of: stages.total },
    { label: 'Search embeddings', done: stages.embeddings, of: stages.total },
    {
      label: 'Photos with faces',
      done: stages.faces_media,
      of: stages.ai_processed,
      hint: `${stages.faces_total} faces found`
    }
  ]

  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 3, maxWidth: 960 }}>
      <Typography variant="h5" sx={{ fontWeight: 600 }}>
        Processing
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Everything runs on this computer. You can pause AI work at any time.
      </Typography>

      {/* Live AI run */}
      <Paper variant="outlined" sx={{ p: 2.5, mb: 3, borderRadius: 3 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
          <Typography variant="h6" sx={{ flex: 1 }}>
            AI processing
          </Typography>
          <Chip
            size="small"
            color={ai.running ? (ai.paused ? 'warning' : 'primary') : 'default'}
            label={
              ai.running
                ? ai.cancelling
                  ? 'Stopping…'
                  : ai.paused
                    ? 'Paused'
                    : 'Running'
                : 'Idle'
            }
          />
        </Stack>

        {ai.running ? (
          <>
            <Typography variant="body2" sx={{ mb: 0.5 }}>
              {ai.processed} of {ai.total} items
              {ai.failed > 0 ? ` · ${ai.failed} failed` : ''}
            </Typography>
            <LinearProgress
              variant="determinate"
              value={pct(ai.processed, ai.total)}
              color={ai.paused ? 'warning' : 'primary'}
              sx={{ height: 8, borderRadius: 4, mb: 1 }}
            />
            {ai.current && (
              <Typography variant="caption" color="text.secondary" noWrap component="div">
                Current: {ai.current}
              </Typography>
            )}
          </>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {pending > 0
              ? `${pending} item(s) waiting for AI analysis.`
              : 'All media has been analyzed.'}
            {ai.finished_at && ` Last run finished ${new Date(ai.finished_at).toLocaleString()}.`}
          </Typography>
        )}

        <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
          {!ai.running && (
            <Button
              variant="contained"
              startIcon={<PlayArrowIcon />}
              onClick={() => act('start')}
              disabled={pending === 0}
            >
              Start
            </Button>
          )}
          {ai.running && !ai.paused && (
            <Button
              variant="outlined"
              startIcon={<PauseIcon />}
              onClick={() => act('pause')}
              disabled={ai.cancelling}
            >
              Pause
            </Button>
          )}
          {ai.running && ai.paused && (
            <Button variant="contained" startIcon={<PlayArrowIcon />} onClick={() => act('resume')}>
              Resume
            </Button>
          )}
          {ai.running && (
            <Button
              variant="outlined"
              color="error"
              startIcon={<StopIcon />}
              onClick={() => act('cancel')}
              disabled={ai.cancelling}
            >
              Cancel
            </Button>
          )}
        </Stack>
      </Paper>

      {/* Scan + watch */}
      <Paper variant="outlined" sx={{ p: 2.5, mb: 3, borderRadius: 3 }}>
        <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="h6" sx={{ flex: 1 }}>
            Scanning
          </Typography>
          <Button
            startIcon={<RefreshIcon />}
            variant="outlined"
            size="small"
            disabled={scan.running}
            onClick={async () => {
              await api.scan()
              setSnap(await api.processing())
            }}
          >
            Scan now
          </Button>
        </Stack>
        {scan.running ? (
          <>
            <Typography variant="body2" sx={{ mb: 0.5 }}>
              {scan.processed} of {scan.total} files · {scan.added} new
            </Typography>
            <LinearProgress
              variant="determinate"
              value={pct(scan.processed, scan.total)}
              sx={{ height: 8, borderRadius: 4 }}
            />
          </>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {stages.total} items in the library · {stages.images} photos · {stages.videos} videos
          </Typography>
        )}
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.5 }}>
          <VisibilityIcon fontSize="small" color={watch.watched ? 'primary' : 'disabled'} />
          <Typography variant="body2" color="text.secondary">
            {watch.watched
              ? `Watching ${watch.watched} folder(s) for new files${
                  watch.added_total ? ` · ${watch.added_total} imported this session` : ''
                }`
              : 'No folders are watched. Turn on auto-import for a folder in Settings.'}
          </Typography>
        </Stack>
      </Paper>

      {/* Stage breakdown */}
      <Paper variant="outlined" sx={{ p: 2.5, mb: 3, borderRadius: 3 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>
          Library status
        </Typography>
        <Stack spacing={1.75}>
          {STAGES.map((s) => (
            <Box key={s.label}>
              <Stack direction="row" sx={{ mb: 0.5 }}>
                <Typography variant="body2" sx={{ flex: 1 }}>
                  {s.label}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {s.hint ? `${s.hint} · ` : ''}
                  {s.done}/{s.of}
                </Typography>
              </Stack>
              <LinearProgress
                variant="determinate"
                value={pct(s.done, s.of)}
                sx={{ height: 6, borderRadius: 3 }}
              />
            </Box>
          ))}
        </Stack>
        {stages.duplicates > 0 && (
          <Alert
            severity="info"
            sx={{ mt: 2 }}
            icon={<ContentCopyIcon />}
            action={
              <Button color="inherit" size="small" onClick={() => navigate('/duplicates')}>
                Review
              </Button>
            }
          >
            {stages.duplicates} files are exact duplicates of another file.
          </Alert>
        )}
      </Paper>

      {/* Failures */}
      <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3 }}>
        <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="h6" sx={{ flex: 1 }}>
            Failed items {failed.length > 0 && `(${failed.length})`}
          </Typography>
          <Button
            startIcon={<ReplayIcon />}
            variant="outlined"
            size="small"
            disabled={failed.length === 0}
            onClick={() => act('retry')}
          >
            Retry all
          </Button>
        </Stack>
        {failed.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No failures.
          </Typography>
        ) : (
          <List dense disablePadding>
            {failed.map((f) => (
              <ListItem key={f.id} disableGutters divider>
                <ListItemText
                  primary={f.filename}
                  secondary={f.ai_error}
                  secondaryTypographyProps={{ sx: { wordBreak: 'break-word' } }}
                />
              </ListItem>
            ))}
          </List>
        )}
      </Paper>
    </Box>
  )
}
