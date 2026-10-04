import { useCallback } from 'react'
import { api, emitLibraryChanged } from '../api/client'
import type { MediaFlag } from '../api/types'
import { useNotify } from '../context/FeedbackContext'

const MESSAGES: Record<MediaFlag, [string, string]> = {
  // [message when set, message when cleared]
  is_favorite: ['Added to favorites', 'Removed from favorites'],
  is_archived: ['Archived', 'Unarchived'],
  is_hidden: ['Hidden', 'Unhidden'],
  is_trashed: ['Moved to trash', 'Restored']
}

function plural(n: number): string {
  return n === 1 ? '1 item' : `${n} items`
}

/**
 * Change a flag on one or more photos, then show a snackbar with Undo.
 * `onDone` runs after both the change and an undo so callers can refetch.
 */
export function useMediaActions(onDone?: () => void) {
  const notify = useNotify()

  const setFlag = useCallback(
    async (ids: number[], flag: MediaFlag, value: boolean): Promise<void> => {
      if (ids.length === 0) return
      try {
        await api.setFlags(ids, flag, value)
      } catch (e) {
        notify(`Couldn't update: ${String(e)}`, { severity: 'error' })
        return
      }
      emitLibraryChanged()
      onDone?.()
      const [on, off] = MESSAGES[flag]
      const message = `${value ? on : off}${ids.length > 1 ? ` · ${plural(ids.length)}` : ''}`
      // Favoriting is trivially reversible in place, so no Undo for it.
      const reversible = flag !== 'is_favorite'
      notify(message, {
        undo: reversible
          ? async () => {
              await api.setFlags(ids, flag, !value)
              emitLibraryChanged()
              onDone?.()
            }
          : undefined
      })
    },
    [notify, onDone]
  )

  return { setFlag }
}
