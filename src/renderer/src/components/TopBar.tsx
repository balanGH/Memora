import { useState, KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AppBar,
  Toolbar,
  InputBase,
  Box,
  IconButton,
  Tooltip,
  Chip,
  CircularProgress,
  alpha
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import DarkModeIcon from '@mui/icons-material/DarkMode'
import LightModeIcon from '@mui/icons-material/LightMode'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import { useColorMode } from '../context/ColorModeContext'
import { useScanStatus } from '../hooks/useScanStatus'

export default function TopBar(): JSX.Element {
  const { mode, toggle } = useColorMode()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const scan = useScanStatus()

  const onSearch = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && q.trim()) {
      navigate(`/search?q=${encodeURIComponent(q.trim())}`)
    }
  }

  const scanBusy = scan?.scan.running
  const aiBusy = scan?.ai.running

  return (
    <AppBar
      position="static"
      color="transparent"
      elevation={0}
      sx={{ borderBottom: (t) => `1px solid ${t.palette.divider}` }}
    >
      <Toolbar sx={{ gap: 2 }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            bgcolor: (t) => alpha(t.palette.text.primary, mode === 'dark' ? 0.08 : 0.05),
            borderRadius: 999,
            px: 2,
            py: 0.5,
            width: 'min(560px, 45vw)'
          }}
        >
          <SearchIcon fontSize="small" sx={{ mr: 1, opacity: 0.6 }} />
          <InputBase
            fullWidth
            placeholder='Search your photos — try "dog", "beach", "sunset"'
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onSearch}
          />
        </Box>

        <Box sx={{ flex: 1 }} />

        {scanBusy && (
          <Chip
            icon={<CircularProgress size={14} sx={{ ml: 1 }} />}
            label={`Scanning ${scan!.scan.processed}/${scan!.scan.total}`}
            size="small"
            variant="outlined"
          />
        )}
        {!scanBusy && aiBusy && (
          <Chip
            icon={<AutoFixHighIcon fontSize="small" />}
            label={`AI ${scan!.ai.processed}/${scan!.ai.total}`}
            size="small"
            variant="outlined"
            color="primary"
          />
        )}

        <Tooltip title={mode === 'dark' ? 'Light theme' : 'Dark theme'}>
          <IconButton onClick={toggle}>
            {mode === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}
          </IconButton>
        </Tooltip>
      </Toolbar>
    </AppBar>
  )
}
