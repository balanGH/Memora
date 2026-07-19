import { useEffect, useMemo, useState } from 'react'
import { Box, Typography, Chip, Link, Stack } from '@mui/material'
import PublicIcon from '@mui/icons-material/Public'
import PhotoGrid from '../components/PhotoGrid'
import PhotoViewer from '../components/PhotoViewer'
import { api, thumbUrl } from '../api/client'
import type { MediaItem, Place } from '../api/types'

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
  const graticule = useMemo(() => {
    const lines: JSX.Element[] = []
    for (let lon = -180; lon <= 180; lon += 30)
      lines.push(
        <line key={`v${lon}`} x1={lon + 180} y1={0} x2={lon + 180} y2={180}
          stroke="currentColor" strokeWidth={0.2} opacity={0.25} />
      )
    for (let lat = -90; lat <= 90; lat += 30)
      lines.push(
        <line key={`h${lat}`} x1={0} y1={90 - lat} x2={360} y2={90 - lat}
          stroke="currentColor" strokeWidth={0.2} opacity={0.25} />
      )
    return lines
  }, [])

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

      {/* Offline world map */}
      <Box sx={{ px: 3 }}>
        <Box
          sx={{
            position: 'relative',
            borderRadius: 3,
            overflow: 'hidden',
            border: (t) => `1px solid ${t.palette.divider}`,
            bgcolor: (t) => (t.palette.mode === 'dark' ? '#12161f' : '#eef3fb'),
            color: (t) => (t.palette.mode === 'dark' ? '#5b6b86' : '#9fb2d0')
          }}
        >
          <svg viewBox="0 0 360 180" style={{ width: '100%', display: 'block' }}>
            {graticule}
            {/* equator + prime meridian emphasized */}
            <line x1={0} y1={90} x2={360} y2={90} stroke="currentColor" strokeWidth={0.4} opacity={0.5} />
            <line x1={180} y1={0} x2={180} y2={180} stroke="currentColor" strokeWidth={0.4} opacity={0.5} />
            {places.map((p) => {
              const [x, y] = project(p.lat, p.lon)
              const r = 1.5 + (p.count / maxCount) * 5
              const isSel = selected?.key === p.key
              return (
                <circle
                  key={p.key}
                  cx={x}
                  cy={y}
                  r={r}
                  onClick={() => select(p)}
                  style={{ cursor: 'pointer' }}
                  fill={isSel ? '#ea4335' : '#1a73e8'}
                  fillOpacity={0.85}
                  stroke="#fff"
                  strokeWidth={0.3}
                />
              )
            })}
          </svg>
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
