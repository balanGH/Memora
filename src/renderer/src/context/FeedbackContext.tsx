import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { Alert, Button, Snackbar } from '@mui/material'

interface NotifyOptions {
  /** Shows an Undo button that runs this callback. */
  undo?: () => unknown | Promise<unknown>
  severity?: 'success' | 'info' | 'warning' | 'error'
}

interface Toast extends NotifyOptions {
  key: number
  message: string
}

type Notify = (message: string, options?: NotifyOptions) => void

const FeedbackContext = createContext<Notify>(() => {})

/**
 * App-wide snackbar. Destructive-but-reversible actions (trash, archive, hide)
 * use this with an Undo callback instead of a confirm dialog.
 */
export function FeedbackProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toast, setToast] = useState<Toast | null>(null)

  const notify = useCallback<Notify>((message, options) => {
    setToast({ key: Date.now(), message, ...options })
  }, [])

  const close = (): void => setToast(null)
  const undo = async (): Promise<void> => {
    const fn = toast?.undo
    close()
    if (fn) await fn()
  }

  const value = useMemo(() => notify, [notify])

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <Snackbar
        key={toast?.key}
        open={!!toast}
        autoHideDuration={toast?.undo ? 6000 : 3500}
        onClose={(_, reason) => reason !== 'clickaway' && close()}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        // Above the fullscreen photo viewer modal.
        sx={{ zIndex: (t) => t.zIndex.modal + 3 }}
      >
        {toast ? (
          <Alert
            severity={toast.severity ?? 'success'}
            variant="filled"
            onClose={close}
            action={
              toast.undo ? (
                <Button color="inherit" size="small" onClick={undo}>
                  Undo
                </Button>
              ) : undefined
            }
            sx={{ alignItems: 'center' }}
          >
            {toast.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </FeedbackContext.Provider>
  )
}

export function useNotify(): Notify {
  return useContext(FeedbackContext)
}
