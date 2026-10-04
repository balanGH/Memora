import { memo, type MouseEvent } from 'react'
import { Box } from '@mui/material'
import FavoriteIcon from '@mui/icons-material/Favorite'
import PlayCircleIcon from '@mui/icons-material/PlayCircle'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked'
import { thumbUrl } from '../api/client'
import type { MediaItem } from '../api/types'

interface Props {
  item: MediaItem
  width: number
  height: number
  onClick: (e: MouseEvent) => void
  /** Selection is possible on this grid (shows the hover checkbox). */
  selectable?: boolean
  selected?: boolean
  /** Some item is selected, so checkboxes stay visible on every tile. */
  selectionActive?: boolean
  focused?: boolean
  onCheckMouseDown?: (e: MouseEvent) => void
  onMouseEnter?: () => void
}

/** Accessible description: kind, date, favorite state. */
export function describeItem(item: MediaItem): string {
  const kind = item.kind === 'video' ? 'Video' : 'Photo'
  const date = item.taken_at
    ? new Date(item.taken_at).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
    : 'unknown date'
  return `${kind}, ${date}, ${item.filename}${item.is_favorite ? ', favorite' : ''}`
}

function PhotoTile({
  item,
  width,
  height,
  onClick,
  selectable,
  selected,
  selectionActive,
  focused,
  onCheckMouseDown,
  onMouseEnter
}: Props): JSX.Element {
  const showCheck = selectable && (selected || selectionActive)
  return (
    <Box
      id={`tile-${item.id}`}
      role="gridcell"
      aria-selected={selectable ? !!selected : undefined}
      aria-label={describeItem(item)}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      sx={{
        position: 'relative',
        width,
        height,
        borderRadius: 2,
        overflow: 'hidden',
        cursor: 'pointer',
        bgcolor: selected ? 'action.selected' : 'action.hover',
        transition: 'transform 0.12s ease',
        outline: (t) => (focused ? `3px solid ${t.palette.primary.main}` : 'none'),
        outlineOffset: -3,
        '&:hover': { transform: selected ? undefined : 'scale(1.012)' },
        '&:hover .memora-overlay, &:hover .memora-check': { opacity: 1 }
      }}
    >
      <Box
        sx={{
          width: '100%',
          height: '100%',
          // Selected tiles shrink inside a tinted frame, like Google Photos.
          transform: selected ? 'scale(0.86)' : 'none',
          transition: 'transform 0.12s ease',
          borderRadius: selected ? 1.5 : 0,
          overflow: 'hidden'
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
            alt=""
            loading="lazy"
            draggable={false}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        )}
      </Box>
      <Box
        className="memora-overlay"
        sx={{
          position: 'absolute',
          inset: 0,
          opacity: showCheck ? 1 : 0,
          transition: 'opacity 0.15s ease',
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.28) 0%, rgba(0,0,0,0) 32%)',
          pointerEvents: 'none'
        }}
      />
      {selectable && (
        <Box
          className="memora-check"
          role="checkbox"
          aria-checked={!!selected}
          aria-label={selected ? 'Deselect' : 'Select'}
          onMouseDown={onCheckMouseDown}
          onClick={(e) => e.stopPropagation()}
          sx={{
            position: 'absolute',
            top: 4,
            left: 4,
            p: 0.25,
            lineHeight: 0,
            opacity: showCheck ? 1 : 0,
            transition: 'opacity 0.15s ease',
            color: selected ? 'primary.main' : '#fff',
            filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))',
            borderRadius: '50%',
            bgcolor: selected ? 'background.paper' : 'transparent'
          }}
        >
          {selected ? <CheckCircleIcon /> : <RadioButtonUncheckedIcon />}
        </Box>
      )}
      {item.is_favorite && (
        <FavoriteIcon
          aria-hidden
          sx={{
            position: 'absolute',
            bottom: 6,
            left: 6,
            fontSize: 18,
            color: '#fff',
            filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))'
          }}
        />
      )}
      {item.kind === 'video' && (
        <PlayCircleIcon
          aria-hidden
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

export default memo(PhotoTile)
