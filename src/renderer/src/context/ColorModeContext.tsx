import { createContext, useContext } from 'react'

export interface ColorModeCtx {
  mode: 'light' | 'dark'
  toggle: () => void
}

export const ColorModeContext = createContext<ColorModeCtx>({
  mode: 'light',
  toggle: () => {}
})

export const useColorMode = (): ColorModeCtx => useContext(ColorModeContext)
