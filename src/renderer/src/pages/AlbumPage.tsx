import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Box, IconButton, Typography } from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import PhotoGrid from '../components/PhotoGrid'
import PhotoViewer from '../components/PhotoViewer'
import { api } from '../api/client'
import type { Album, MediaItem } from '../api/types'

export default function AlbumPage(): JSX.Element {
  const { id } = useParams()
  const albumId = Number(id)
  const navigate = useNavigate()
  const [items, setItems] = useState<MediaItem[]>([])
  const [album, setAlbum] = useState<Album | null>(null)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)

  useEffect(() => {
    api.albumMedia(albumId).then((r) => setItems(r.items))
    api.albums().then((r) => setAlbum(r.albums.find((a) => a.id === albumId) ?? null))
  }, [albumId])

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box
        sx={{
          px: 2.5,
          py: 1.5,
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          borderBottom: (t) => `1px solid ${t.palette.divider}`
        }}
      >
        <IconButton onClick={() => navigate('/albums')}>
          <ArrowBackIcon />
        </IconButton>
        <Typography variant="h6">{album?.name ?? 'Album'}</Typography>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <PhotoGrid items={items} grouping="month" onOpen={setViewerIndex} />
      </Box>
      {viewerIndex !== null && (
        <PhotoViewer
          items={items}
          index={viewerIndex}
          onClose={() => setViewerIndex(null)}
          onIndexChange={setViewerIndex}
        />
      )}
    </Box>
  )
}
