import { Box } from '@mui/material'
import FavoriteIcon from '@mui/icons-material/Favorite'
import PlayCircleIcon from '@mui/icons-material/PlayCircle'
import { thumbUrl } from '../api/client'
import type { MediaItem } from '../api/types'

interface Props {
  item: MediaItem
  width: number
  height: number
  onClick: () => void
}

export default function PhotoTile({ item, width, height, onClick }: Props): JSX.Element {
  return (
    <Box
      onClick={onClick}
      sx={{
        position: 'relative',
        width,
        height,
        borderRadius: 2,
        overflow: 'hidden',
        cursor: 'pointer',
        bgcolor: 'action.hover',
        transition: 'transform 0.12s ease',
        '&:hover': { transform: 'scale(1.012)' },
        '&:hover .memora-overlay': { opacity: 1 }
      }}
    >
      {item.kind === 'video' && !item.thumb_path ? (
        <Box
          sx={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: (t) => (t.palette.mode === 'dark' ? '#22252c' : '#e8eaed')
          }}
        >
          <PlayCircleIcon sx={{ fontSize: 40, opacity: 0.55 }} />
        </Box>
      ) : (
        <img
          className="memora-tile-img"
          src={thumbUrl(item.id)}
          alt={item.filename}
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      )}
      <Box
        className="memora-overlay"
        sx={{
          position: 'absolute',
          inset: 0,
          opacity: 0,
          transition: 'opacity 0.15s ease',
          background:
            'linear-gradient(to bottom, rgba(0,0,0,0.28) 0%, rgba(0,0,0,0) 32%)',
          pointerEvents: 'none'
        }}
      />
      {item.is_favorite && (
        <FavoriteIcon
          sx={{
            position: 'absolute',
            top: 6,
            left: 6,
            fontSize: 18,
            color: '#fff',
            filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))'
          }}
        />
      )}
      {item.kind === 'video' && (
        <PlayCircleIcon
          sx={{
            position: 'absolute',
            top: 6,
            right: 6,
            color: '#fff',
            filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))'
          }}
        />
      )}
    </Box>
  )
}
