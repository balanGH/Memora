import { useEffect, useMemo, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Box, CssBaseline, ThemeProvider } from '@mui/material'
import { buildTheme } from './theme'
import { ColorModeContext } from './context/ColorModeContext'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import LibraryPage from './pages/LibraryPage'
import PeoplePage from './pages/PeoplePage'
import PersonPage from './pages/PersonPage'
import SearchPage from './pages/SearchPage'
import AlbumsPage from './pages/AlbumsPage'
import AlbumPage from './pages/AlbumPage'
import SettingsPage from './pages/SettingsPage'

const THEME_KEY = 'memora.theme'

export default function App(): JSX.Element {
  const [mode, setMode] = useState<'light' | 'dark'>('dark')

  useEffect(() => {
    const saved = localStorage.getItem(THEME_KEY) as 'light' | 'dark' | null
    if (saved) {
      setMode(saved)
    } else {
      window.memora?.getSystemTheme().then((t) => setMode(t)).catch(() => {})
    }
  }, [])

  const colorMode = useMemo(
    () => ({
      mode,
      toggle: () =>
        setMode((prev) => {
          const next = prev === 'light' ? 'dark' : 'light'
          localStorage.setItem(THEME_KEY, next)
          return next
        })
    }),
    [mode]
  )

  const theme = useMemo(() => buildTheme(mode), [mode])

  return (
    <ColorModeContext.Provider value={colorMode}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
          <Sidebar />
          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <TopBar />
            <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              <Routes>
                <Route path="/" element={<Navigate to="/photos" replace />} />
                <Route path="/photos" element={<LibraryPage view="photos" />} />
                <Route path="/favorites" element={<LibraryPage view="favorites" />} />
                <Route path="/archive" element={<LibraryPage view="archive" />} />
                <Route path="/hidden" element={<LibraryPage view="hidden" />} />
                <Route path="/trash" element={<LibraryPage view="trash" />} />
                <Route path="/people" element={<PeoplePage />} />
                <Route path="/people/:id" element={<PersonPage />} />
                <Route path="/search" element={<SearchPage />} />
                <Route path="/albums" element={<AlbumsPage />} />
                <Route path="/albums/:id" element={<AlbumPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Routes>
            </Box>
          </Box>
        </Box>
      </ThemeProvider>
    </ColorModeContext.Provider>
  )
}
