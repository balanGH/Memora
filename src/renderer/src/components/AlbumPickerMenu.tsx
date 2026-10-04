import { useEffect, useState } from 'react'
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Menu,
  MenuItem,
  TextField
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import { api } from '../api/client'
import type { Album } from '../api/types'
import { useNotify } from '../context/FeedbackContext'

interface Props {
  anchorEl: HTMLElement | null
  onClose: () => void
  mediaIds: number[]
  /** Raise above the fullscreen viewer modal. */
  overModal?: boolean
  onAdded?: () => void
}

/** "Add to album" menu with an inline "New album…" dialog. */
export default function AlbumPickerMenu({
  anchorEl,
  onClose,
  mediaIds,
  overModal,
  onAdded
}: Props): JSX.Element {
  const [albums, setAlbums] = useState<Album[]>([])
  const [newOpen, setNewOpen] = useState(false)
  const [name, setName] = useState('')
  const notify = useNotify()
  const z = overModal ? { zIndex: (t: { zIndex: { modal: number } }) => t.zIndex.modal + 2 } : {}

  useEffect(() => {
    if (anchorEl) api.albums().then((r) => setAlbums(r.albums))
  }, [anchorEl])

  const count = mediaIds.length === 1 ? '' : ` ${mediaIds.length} items`

  const add = async (album: Album): Promise<void> => {
    onClose()
    const r = await api.addToAlbum(album.id, mediaIds)
    notify(
      r.added > 0
        ? `Added${count} to “${album.name}”`
        : `Already in “${album.name}”`,
      { severity: r.added > 0 ? 'success' : 'info' }
    )
    onAdded?.()
  }

  const create = async (): Promise<void> => {
    const n = name.trim()
    if (!n) return
    const { id } = await api.createAlbum(n)
    await api.addToAlbum(id, mediaIds)
    setName('')
    setNewOpen(false)
    notify(`Added${count} to new album “${n}”`)
    onAdded?.()
  }

  return (
    <>
      <Menu anchorEl={anchorEl} open={!!anchorEl} onClose={onClose} sx={z}>
        {albums.length === 0 && <MenuItem disabled>No albums yet</MenuItem>}
        {albums.map((a) => (
          <MenuItem key={a.id} onClick={() => add(a)}>
            {a.name}
          </MenuItem>
        ))}
        <Divider />
        <MenuItem
          onClick={() => {
            onClose()
            setNewOpen(true)
          }}
        >
          <AddIcon fontSize="small" sx={{ mr: 1 }} /> New album…
        </MenuItem>
      </Menu>
      <Dialog open={newOpen} onClose={() => setNewOpen(false)} sx={z}>
        <DialogTitle>New album</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="Album name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={create} disabled={!name.trim()}>
            Create & add
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
