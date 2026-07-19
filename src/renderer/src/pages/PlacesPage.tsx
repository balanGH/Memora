import { useEffect, useRef, useState, useCallback } from 'react'
import { Box, Typography, Chip, Stack } from '@mui/material'
import PublicIcon from '@mui/icons-material/Public'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import PhotoViewer from '../components/PhotoViewer'
import { api, thumbUrl } from '../api/client'
import type { MediaItem } from '../api/types'

const BASE_STYLE: L.CircleMarkerOptions = {
  radius: 6,
  color: '#ffffff',
  weight: 1.5,
  fillColor: '#1a73e8',
  fillOpacity: 0.9
}
const ACTIVE_STYLE: L.CircleMarkerOptions = {
  radius: 10,
  color: '#ffffff',
  weight: 2,
  fillColor: '#ea4335',
  fillOpacity: 1
}

function dateLabel(taken: string | null): string {
  if (!taken) return ''
  const d = new Date(taken)
  return isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function PlacesPage(): JSX.Element {
  const mapElRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markersRef = useRef<L.CircleMarker[]>([])
  const stripRef = useRef<HTMLDivElement>(null)
  const scrollRaf = useRef<number | null>(null)
  const suppressScroll = useRef(false)

  const [items, setItems] = useState<MediaItem[]>([])
  const [active, setActive] = useState(-1)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)

  // --- init map once -------------------------------------------------------
  useEffect(() => {
    if (mapRef.current || !mapElRef.current) return
    const map = L.map(mapElRef.current, { zoomControl: true, worldCopyJump: true }).setView(
      [20, 0],
      2
    )
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors'
    }).addTo(map)
    mapRef.current = map
    // container starts at final size, but invalidate once to be safe
    setTimeout(() => map.invalidateSize(), 100)
    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  // --- load geotagged photos + build markers -------------------------------
  useEffect(() => {
    api
      .geoMedia()
      .then((r) => setItems(r.items))
      .finally(() => setLoaded(true))
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    markersRef.current.forEach((m) => m.remove())
    markersRef.current = []
    if (items.length === 0) return

    const latlngs: L.LatLngExpression[] = []
    items.forEach((item, i) => {
      const marker = L.circleMarker([item.gps_lat!, item.gps_lon!], BASE_STYLE)
        .addTo(map)
        .on('click', () => selectItem(i, { fromMap: true }))
      marker.bindTooltip(item.filename, { direction: 'top' })
      markersRef.current.push(marker)
      latlngs.push([item.gps_lat!, item.gps_lon!])
    })
    map.fitBounds(L.latLngBounds(latlngs).pad(0.2), { maxZoom: 12 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  // --- selection drives both map and strip ---------------------------------
  const selectItem = useCallback(
    (i: number, opts: { fromMap?: boolean; fromScroll?: boolean } = {}) => {
      setActive(i)
      const map = mapRef.current
      const item = items[i]
      if (map && item) {
        map.flyTo([item.gps_lat!, item.gps_lon!], Math.max(map.getZoom(), 14), {
          duration: 0.6
        })
      }
      // restyle markers
      markersRef.current.forEach((m, idx) =>
        m.setStyle(idx === i ? ACTIVE_STYLE : BASE_STYLE)
      )
      markersRef.current[i]?.bringToFront()
      // scroll the strip to this item (unless the scroll itself triggered us)
      if (!opts.fromScroll) {
        suppressScroll.current = true
        const el = stripRef.current?.children[i] as HTMLElement | undefined
        el?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
        setTimeout(() => (suppressScroll.current = false), 500)
      }
    },
    [items]
  )

  // --- scrolling the strip picks the centered photo ------------------------
  const onStripScroll = useCallback(() => {
    if (suppressScroll.current) return
    if (scrollRaf.current) cancelAnimationFrame(scrollRaf.current)
    scrollRaf.current = requestAnimationFrame(() => {
      const strip = stripRef.current
      if (!strip) return
      const center = strip.scrollLeft + strip.clientWidth / 2
      let best = -1
      let bestDist = Infinity
      Array.from(strip.children).forEach((child, i) => {
        const el = child as HTMLElement
        const c = el.offsetLeft + el.offsetWidth / 2
        const dist = Math.abs(c - center)
        if (dist < bestDist) {
          bestDist = dist
          best = i
        }
      })
      if (best >= 0 && best !== active) selectItem(best, { fromScroll: true })
    })
  }, [active, selectItem])

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ px: 3, pt: 2, pb: 1 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <PublicIcon color="primary" />
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            Places
          </Typography>
          {loaded && <Chip size="small" label={`${items.length} geotagged`} />}
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          Scroll the timeline to fly the map to where each photo was taken. Click a map pin
          to jump the timeline. Double-click a photo to open it.
        </Typography>
      </Box>

      {/* Interactive map */}
      <Box sx={{ flex: 1, minHeight: 0, position: 'relative', mx: 3, borderRadius: 3, overflow: 'hidden' }}>
        <Box ref={mapElRef} sx={{ position: 'absolute', inset: 0 }} />
        {loaded && items.length === 0 && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'column',
              bgcolor: 'background.default',
              color: 'text.secondary',
              zIndex: 500
            }}
          >
            <Typography variant="h6">No geotagged photos yet</Typography>
            <Typography variant="body2">
              Photos need GPS EXIF (usually from a phone camera) to appear on the map.
            </Typography>
          </Box>
        )}
      </Box>

      {/* Timeline filmstrip */}
      <Box
        ref={stripRef}
        onScroll={onStripScroll}
        sx={{
          height: 132,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 3,
          py: 1.5,
          overflowX: 'auto',
          overflowY: 'hidden',
          borderTop: (t) => `1px solid ${t.palette.divider}`,
          scrollBehavior: 'smooth'
        }}
      >
        {items.map((item, i) => (
          <Box
            key={item.id}
            onClick={() => selectItem(i)}
            onDoubleClick={() => setViewerIndex(i)}
            sx={{
              flex: '0 0 auto',
              width: 92,
              cursor: 'pointer',
              textAlign: 'center'
            }}
          >
            <Box
              sx={{
                width: 92,
                height: 72,
                borderRadius: 2,
                overflow: 'hidden',
                border: (t) =>
                  i === active
                    ? `2px solid ${t.palette.error.main}`
                    : `2px solid transparent`,
                transition: 'transform 0.12s ease',
                transform: i === active ? 'scale(1.04)' : 'none'
              }}
            >
              <img
                src={thumbUrl(item.id)}
                alt={item.filename}
                loading="lazy"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            </Box>
            <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
              {dateLabel(item.taken_at)}
            </Typography>
          </Box>
        ))}
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
