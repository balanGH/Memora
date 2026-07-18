/// <reference types="vite/client" />
import type { MemoraApi } from '../../preload'

declare global {
  interface Window {
    memora: MemoraApi
  }
}

export {}
