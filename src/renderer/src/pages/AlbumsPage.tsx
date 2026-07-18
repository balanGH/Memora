import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box,
  Typography,
  Grid,
  Card,
  CardActionArea,
  CardMedia,
  CardContent,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import CollectionsIcon from '@mui/icons-material/Collections'
import { api, thumbUrl } from '../api/client'
import type { Album } from '../api/types'

export default function AlbumsPage(): JSX.Element {
  const [albums, setAlbums] = useState<Album[]>([])
  const [dialog, setDialog] = useState(false)
  const [name, setName] = useState('')
  const navigate = useNavigate()

  const load = (): void => {
    api.albums().then((r) => setAlbums(r.albums))
  }
  useEffect(load, [])

  const create = async (): Promise<void> => {
    if (!name.trim()) return
    await api.createAlbum(name.trim())
    setName('')
    setDialog(false)
    load()
  }

  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 600, flex: 1 }}>
          Albums
        </Typography>
        <Button startIcon={<AddIcon />} variant="contained" onClick={() => setDialog(true)}>
          New album
        </Button>
      </Box>

      {albums.length === 0 && (
        <Typography color="text.secondary">
          No albums yet. Create one, then add photos from the viewer.
        </Typography>
      )}

      <Grid container spacing={2}>
        {albums.map((a) => (
          <Grid item key={a.id} xs={6} sm={4} md={3}>
            <Card variant="outlined" sx={{ borderRadius: 3 }}>
              <CardActionArea onClick={() => navigate(`/albums/${a.id}`)}>
                {a.cover_media_id ? (
                  <CardMedia
                    component="img"
                    height="150"
                    image={thumbUrl(a.cover_media_id)}
                    alt={a.name}
                  />
                ) : (
                  <Box
                    sx={{
                      height: 150,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      bgcolor: 'action.hover'
                    }}
                  >
                    <CollectionsIcon sx={{ fontSize: 48, opacity: 0.4 }} />
                  </Box>
                )}
                <CardContent sx={{ py: 1.5 }}>
                  <Typography noWrap sx={{ fontWeight: 600 }}>
                    {a.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {a.count} {a.count === 1 ? 'item' : 'items'}
                  </Typography>
                </CardContent>
              </CardActionArea>
            </Card>
          </Grid>
        ))}
      </Grid>

      <Dialog open={dialog} onClose={() => setDialog(false)}>
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
          <Button onClick={() => setDialog(false)}>Cancel</Button>
          <Button variant="contained" onClick={create}>
            Create
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
