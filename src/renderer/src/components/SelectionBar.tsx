import { useState } from 'react'
import { Box, Button, IconButton, Tooltip, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import FavoriteIcon from '@mui/icons-material/Favorite'
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder'
import ArchiveIcon from '@mui/icons-material/Archive'
import UnarchiveIcon from '@mui/icons-material/Unarchive'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import VisibilityIcon from '@mui/icons-material/Visibility'
import DeleteIcon from '@mui/icons-material/Delete'
import RestoreFromTrashIcon from '@mui/icons-material/RestoreFromTrash'
import LibraryAddIcon from '@mui/icons-material/LibraryAdd'
import SelectAllIcon from '@mui/icons-material/SelectAll'
import type { LibraryView, MediaItem } from '../api/types'
import { useMediaActions } from '../hooks/useMediaActions'
import AlbumPickerMenu from './AlbumPickerMenu'

interface Props {
  items: MediaItem[]
  selected: Set<number>
  onChange: (next: Set<number>) => void
  /** Which library bucket we're in; flips archive/hide/trash into their undo. */
  view?: LibraryView | 'search'
  /** Refetch after a change. */
  onMutate?: () => void
}

/** Replaces the page header while photos are selected. */
export default function SelectionBar({
  items,
  selected,
  onChange,
  view = 'photos',
  onMutate
}: Props): JSX.Element {
  const [albumAnchor, setAlbumAnchor] = useState<HTMLElement | null>(null)
  const ids = [...selected]
  const clear = (): void => onChange(new Set())
  const { setFlag } = useMediaActions(onMutate)

  // Leaving the current bucket removes items from view: clear the selection.
  const run = async (flag: Parameters<typeof setFlag>[1], value: boolean, keep = false) => {
    await setFlag(ids, flag, value)
    if (!keep) clear()
  }

  const chosen = items.filter((i) => selected.has(i.id))
  const allFav = chosen.length > 0 && chosen.every((i) => i.is_favorite)

  const action = (
    title: string,
    icon: JSX.Element,
    onClick: (e: React.MouseEvent<HTMLElement>) => void
  ): JSX.Element => (
    <Tooltip title={title}>
      <IconButton onClick={onClick} aria-label={title} color="inherit">
        {icon}
      </IconButton>
    </Tooltip>
  )

  return (
    <Box
      role="toolbar"
      aria-label="Selection actions"
      sx={{
        px: 1.5,
        py: 1,
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        bgcolor: (t) => (t.palette.mode === 'dark' ? 'rgba(138,180,248,0.14)' : 'rgba(26,115,232,0.08)'),
        borderBottom: (t) => `1px solid ${t.palette.divider}`
      }}
    >
      {action('Clear selection (Esc)', <CloseIcon />, clear)}
      <Typography sx={{ fontWeight: 600, mr: 1 }} aria-live="polite">
        {selected.size} selected
      </Typography>
      {selected.size < items.length && (
        <Button
          size="small"
          startIcon={<SelectAllIcon />}
          onClick={() => onChange(new Set(items.map((i) => i.id)))}
        >
          Select all {items.length}
        </Button>
      )}
      <Box sx={{ flex: 1 }} />

      {view === 'trash' ? (
        <Button
          startIcon={<RestoreFromTrashIcon />}
          variant="contained"
          onClick={() => run('is_trashed', false)}
        >
          Restore
        </Button>
      ) : (
        <>
          {action(
            allFav ? 'Remove from favorites (f)' : 'Add to favorites (f)',
            allFav ? <FavoriteIcon /> : <FavoriteBorderIcon />,
            () => run('is_favorite', !allFav, view !== 'favorites' || !allFav)
          )}
          {action('Add to album', <LibraryAddIcon />, (e) => setAlbumAnchor(e.currentTarget))}
          {view === 'archive'
            ? action('Unarchive', <UnarchiveIcon />, () => run('is_archived', false))
            : action('Archive (e)', <ArchiveIcon />, () => run('is_archived', true, view === 'search'))}
          {view === 'hidden'
            ? action('Unhide', <VisibilityIcon />, () => run('is_hidden', false))
            : action('Hide', <VisibilityOffIcon />, () => run('is_hidden', true, view === 'search'))}
          {action('Move to trash (Delete)', <DeleteIcon />, () => run('is_trashed', true))}
        </>
      )}
      <AlbumPickerMenu
        anchorEl={albumAnchor}
        onClose={() => setAlbumAnchor(null)}
        mediaIds={ids}
      />
    </Box>
  )
}
