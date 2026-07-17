import { createTheme, type Theme } from '@mui/material/styles'

const shared = {
  shape: { borderRadius: 12 },
  typography: {
    fontFamily: 'Roboto, system-ui, -apple-system, "Segoe UI", sans-serif',
    h6: { fontWeight: 600 },
    subtitle1: { fontWeight: 600 }
  }
}

export function buildTheme(mode: 'light' | 'dark'): Theme {
  return createTheme({
    ...shared,
    palette: {
      mode,
      primary: { main: mode === 'dark' ? '#8ab4f8' : '#1a73e8' },
      background:
        mode === 'dark'
          ? { default: '#0f1115', paper: '#1a1c22' }
          : { default: '#ffffff', paper: '#ffffff' }
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          '::-webkit-scrollbar': { width: 10, height: 10 },
          '::-webkit-scrollbar-thumb': {
            background: mode === 'dark' ? '#3a3d45' : '#c9ccd1',
            borderRadius: 8
          }
        }
      },
      MuiButton: { defaultProps: { disableElevation: true } }
    }
  })
}
