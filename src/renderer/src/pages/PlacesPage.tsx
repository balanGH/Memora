import { useEffect, useMemo, useState } from 'react'
import { Box, Typography, Chip, Link, Stack } from '@mui/material'
import PublicIcon from '@mui/icons-material/Public'
import PhotoGrid from '../components/PhotoGrid'
import PhotoViewer from '../components/PhotoViewer'
import { api, thumbUrl } from '../api/client'
import type { MediaItem, Place } from '../api/types'
import { WORLD_LAND_PATH, heatColor } from '../components/worldMap'

// Equirectangular projection: lon/lat -> SVG coords on a 360x180 canvas.
const project = (lat: number, lon: number): [number, number] => [lon + 180, 90 - lat]

export default function PlacesPage(): JSX.Element {
  const [places, setPlaces] = useState<Place[]>([])
  const [selected, setSelected] = useState<Place | null>(null)
  const [items, setItems] = useState<MediaItem[]>([])
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    api
      .places()
      .then((r) => {
        setPlaces(r.places)
        if (r.places.length) select(r.places[0])
      })
      .finally(() => setLoaded(true))
  }, [])

  const select = (p: Place): void => {
    setSelected(p)
    api.placeMedia(p.key).then((r) => setItems(r.items))
  }

  const maxCount = useMemo(
    () => places.reduce((m, p) => Math.max(m, p.count), 1),
    [places]
  )

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ p: 3, pb: 1 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <PublicIcon color="primary" />
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            Places
          </Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          Photos with GPS location, grouped into places. Offline map — click a dot to see
          those photos.
        </Typography>
      </Box>

      {/* Offline world map — height-capped so the photo grid below stays visible */}
      <Box sx={{ px: 3, flexShrink: 0 }}>
        <Box
          sx={{
            position: 'relative',
            height: 'clamp(160px, 32vh, 280px)',
            borderRadius: 3,
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: (t) => `1px solid ${t.palette.divider}`,
            bgcolor: (t) => (t.palette.mode === 'dark' ? '#12161f' : '#eef3fb'),
            color: (t) => (t.palette.mode === 'dark' ? '#5b6b86' : '#9fb2d0')
          }}
        >
          <svg
            viewBox="0 0 360 180"
            preserveAspectRatio="xMidYMid meet"
            style={{ width: '100%', height: '100%', display: 'block' }}
          >
            {/* ocean */}
            <rect x={0} y={0} width={360} height={180} fill="currentColor" opacity={0.06} />
            {/* real landmasses (bundled GeoJSON, drawn offline) */}
            <path
              d={WORLD_LAND_PATH}
              fill="currentColor"
              fillOpacity={0.24}
              stroke="currentColor"
              strokeOpacity={0.35}
              strokeWidth={0.12}
            />
            {/* photo clusters — color + size by intensity (photo count) */}
            {places.map((p) => {
              const [x, y] = project(p.lat, p.lon)
              const t = p.count / maxCount
              const r = 1.4 + t * 4.5
              const color = heatColor(t)
              const isSel = selected?.key === p.key
              return (
                <g key={p.key} onClick={() => select(p)} style={{ cursor: 'pointer' }}>
                  {/* soft heat glow */}
                  <circle cx={x} cy={y} r={r * 2.4} fill={color} fillOpacity={0.18} />
                  <circle
                    cx={x}
                    cy={y}
                    r={r}
                    fill={color}
                    fillOpacity={0.95}
                    stroke={isSel ? '#fff' : color}
                    strokeWidth={isSel ? 0.9 : 0.3}
                  />
                </g>
              )
            })}
          </svg>
          {/* intensity legend */}
          <Box
            sx={{
              position: 'absolute',
              right: 12,
              bottom: 10,
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              px: 1,
              py: 0.5,
              borderRadius: 2,
              bgcolor: (t) => (t.palette.mode === 'dark' ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.7)')
            }}
          >
            <Typography variant="caption" color="text.secondary">
              Fewer
            </Typography>
            <Box
              sx={{
                width: 80,
                height: 8,
                borderRadius: 4,
                background: `linear-gradient(90deg, ${heatColor(0)}, ${heatColor(0.5)}, ${heatColor(1)})`
              }}
            />
            <Typography variant="caption" color="text.secondary">
              More
            </Typography>
          </Box>
        </Box>
      </Box>

      {/* Selected place header */}
      {selected && (
        <Box sx={{ px: 3, py: 1.5, display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Box
            component="img"
            src={thumbUrl(selected.cover_id)}
            sx={{ width: 44, height: 44, borderRadius: 2, objectFit: 'cover' }}
          />
          <Box sx={{ flex: 1 }}>
            <Typography sx={{ fontWeight: 600 }}>
              {selected.lat.toFixed(3)}, {selected.lon.toFixed(3)}
            </Typography>
            <Link
              href={`https://www.openstreetmap.org/?mlat=${selected.lat}&mlon=${selected.lon}#map=10/${selected.lat}/${selected.lon}`}
              target="_blank"
              rel="noreferrer"
              variant="caption"
            >
              Open in OpenStreetMap
            </Link>
          </Box>
          <Chip label={`${selected.count} photos`} size="small" />
        </Box>
      )}

      <Box sx={{ flex: 1, minHeight: 0 }}>
        {loaded && places.length === 0 ? (
          <Box sx={{ p: 3, color: 'text.secondary' }}>
            <Typography>No geotagged photos yet.</Typography>
            <Typography variant="body2">
              Photos need GPS EXIF data (usually from a phone camera) to appear here.
            </Typography>
          </Box>
        ) : (
          <PhotoGrid items={items} grouping="month" onOpen={setViewerIndex} />
        )}
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
