import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  LinearProgress,
  Popover,
  Stack,
  Typography
} from '@mui/material'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import PauseIcon from '@mui/icons-material/Pause'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import StopIcon from '@mui/icons-material/Stop'
import { api } from '../api/client'
import { refreshScanStatus, useScanStatus } from '../hooks/useScanStatus'

/** Top-bar status chip; click for details and pause / resume / cancel. */
export default function ProgressPill(): JSX.Element | null {
  const status = useScanStatus()
  const navigate = useNavigate()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)

  const scan = status?.scan
  const ai = status?.ai
  if (!scan?.running && !ai?.running) return null

  const act = async (action: 'pause' | 'resume' | 'cancel'): Promise<void> => {
    await api.processingAction(action)
    refreshScanStatus()
  }
  const pct = (n: number, d: number): number => (d ? (n / d) * 100 : 0)

  const label = scan?.running
    ? `Scanning ${scan.processed}/${scan.total}`
    : `${ai?.paused ? 'Paused' : 'AI'} ${ai?.processed}/${ai?.total}`

  return (
    <>
      <Chip
        icon={
          scan?.running ? (
            <CircularProgress size={14} sx={{ ml: 1 }} />
          ) : (
            <AutoFixHighIcon fontSize="small" />
          )
        }
        label={label}
        size="small"
        variant="outlined"
        color={scan?.running ? 'default' : ai?.paused ? 'warning' : 'primary'}
        onClick={(e) => setAnchor(e.currentTarget)}
        aria-haspopup="dialog"
        aria-label={`${label}. Show processing details`}
      />
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <Box sx={{ p: 2, width: 320 }}>
          {scan?.running && (
            <Box sx={{ mb: 2 }}>
              <Typography variant="subtitle2">Scanning folders</Typography>
              <Typography variant="caption" color="text.secondary" noWrap component="div">
                {scan.current_folder ?? 'Preparing…'}
              </Typography>
              <LinearProgress
                variant="determinate"
                value={pct(scan.processed, scan.total)}
                sx={{ my: 0.75, borderRadius: 2 }}
              />
              <Typography variant="caption">
                {scan.processed}/{scan.total} files · {scan.added} new
              </Typography>
            </Box>
          )}
          {ai?.running && (
            <Box>
              <Typography variant="subtitle2">
                AI analysis {ai.paused ? '(paused)' : ''}
              </Typography>
              <LinearProgress
                variant="determinate"
                value={pct(ai.processed, ai.total)}
                color={ai.paused ? 'warning' : 'primary'}
                sx={{ my: 0.75, borderRadius: 2 }}
              />
              <Typography variant="caption">
                {ai.processed}/{ai.total} items · faces, tags, search
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
                {ai.paused ? (
                  <Button size="small" startIcon={<PlayArrowIcon />} onClick={() => act('resume')}>
                    Resume
                  </Button>
                ) : (
                  <Button size="small" startIcon={<PauseIcon />} onClick={() => act('pause')}>
                    Pause
                  </Button>
                )}
                <Button
                  size="small"
                  color="error"
                  startIcon={<StopIcon />}
                  onClick={() => act('cancel')}
                >
                  Cancel
                </Button>
              </Stack>
            </Box>
          )}
          <Button
            fullWidth
            variant="outlined"
            size="small"
            sx={{ mt: 2 }}
            onClick={() => {
              setAnchor(null)
              navigate('/processing')
            }}
          >
            Open Processing
          </Button>
        </Box>
      </Popover>
    </>
  )
}
