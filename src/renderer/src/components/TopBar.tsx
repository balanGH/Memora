import {
  AppBar,
  Toolbar,
  Box,
  IconButton,
  Tooltip
} from '@mui/material'
import DarkModeIcon from '@mui/icons-material/DarkMode'
import LightModeIcon from '@mui/icons-material/LightMode'
import { useColorMode } from '../context/ColorModeContext'
import ProgressPill from './ProgressPill'
import SearchBox from './SearchBox'

export default function TopBar(): JSX.Element {
  const { mode, toggle } = useColorMode()

  return (
    <AppBar
      position="static"
      color="transparent"
      elevation={0}
      sx={{ borderBottom: (t) => `1px solid ${t.palette.divider}` }}
    >
      <Toolbar sx={{ gap: 2 }}>
        <SearchBox dark={mode === 'dark'} />

        <Box sx={{ flex: 1 }} />

        <ProgressPill />

        <Tooltip title={mode === 'dark' ? 'Light theme' : 'Dark theme'}>
          <IconButton onClick={toggle} aria-label={mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
            {mode === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}
          </IconButton>
        </Tooltip>
      </Toolbar>
    </AppBar>
  )
}
