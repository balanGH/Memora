import { useEffect, useRef, useState, useCallback } from 'react'
import { Box, Typography, Chip, Stack, ToggleButton, ToggleButtonGroup } from '@mui/material'
import PublicIcon from '@mui/icons-material/Public'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import PhotoViewer from '../components/PhotoViewer'
import { heatLayer, type HeatPoint } from '../components/heatLayer'
import { api, thumbUrl, tileUrlTemplate } from '../api/client'
import type { MediaItem } from '../api/types'
import { useColorMode } from '../context/ColorModeContext'

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
// Zero-footprint marker: invisible, but still anchors the photo-preview tooltip
// (used in pins mode where the red base dot already marks the spot).
const INVISIBLE_STYLE: L.CircleMarkerOptions = {
  radius: 0,
  weight: 0,
  opacity: 0,
  fillOpacity: 0
}

function dateLabel(taken: string | null): string {
  if (!taken) return ''
  const d = new Date(taken)
  return isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function PlacesPage(): JSX.Element {
  const { mode } = useColorMode()
  const mapElRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const tileLayerRef = useRef<L.TileLayer | null>(null)
  const markersRef = useRef<L.CircleMarker[]>([])
  const heatRef = useRef<L.Layer | null>(null)
  const activeMarkerRef = useRef<L.CircleMarker | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const scrollRaf = useRef<number | null>(null)
  const suppressScroll = useRef(false)

  const [items, setItems] = useState<MediaItem[]>([])
  const [active, setActive] = useState(-1)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest')
  const [viewMode, setViewMode] = useState<'heat' | 'pins'>('heat')

  // --- init map once -------------------------------------------------------
  useEffect(() => {
    if (mapRef.current || !mapElRef.current) return
    const map = L.map(mapElRef.current, { zoomControl: true, worldCopyJump: true }).setView(
      [20, 0],
      2
    )
    // Tiles come from the local caching proxy — downloaded once, then served
    // from disk (works offline on revisit). Blank tile shown when uncached +
    // offline, instead of a broken image.
    tileLayerRef.current = L.tileLayer(
      tileUrlTemplate(mode === 'dark' ? 'dark' : 'light'),
      {
        maxZoom: 20,
        attribution: '© OpenStreetMap contributors © CARTO',
        errorTileUrl:
          'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="%23e8eaed"/></svg>'
      }
    ).addTo(map)
    mapRef.current = map
    // container starts at final size, but invalidate once to be safe
    setTimeout(() => map.invalidateSize(), 100)
    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  // Swap the basemap style to match the app theme (no map rebuild).
  useEffect(() => {
    tileLayerRef.current?.setUrl(tileUrlTemplate(mode === 'dark' ? 'dark' : 'light'))
  }, [mode])

  // --- load geotagged photos + build markers -------------------------------
  useEffect(() => {
    setActive(-1)
    api
      .geoMedia(sort)
      .then((r) => setItems(r.items))
      .finally(() => setLoaded(true))
  }, [sort])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    // clear every overlay so switching modes leaves nothing behind
    markersRef.current.forEach((m) => m.remove())
    markersRef.current = []
    if (heatRef.current) {
      heatRef.current.remove()
      heatRef.current = null
    }
    if (activeMarkerRef.current) {
      activeMarkerRef.current.remove()
      activeMarkerRef.current = null
    }
    if (items.length === 0) return

    const latlngs = items.map(
      (it) => [it.gps_lat!, it.gps_lon!] as L.LatLngExpression
    )

    if (viewMode === 'heat') {
      const points: HeatPoint[] = items.map((it) => ({
        lat: it.gps_lat!,
        lng: it.gps_lon!,
        value: 1
      }))
      heatRef.current = heatLayer(points, {
        radius: 15,
        blur: 10,
        minOpacity: 0.4
      }).addTo(map)
    } else {
      items.forEach((item, i) => {
        const marker = L.circleMarker([item.gps_lat!, item.gps_lon!], BASE_STYLE)
          .addTo(map)
          .on('click', () => selectItem(i, { fromMap: true }))
        marker.bindTooltip(item.filename, { direction: 'top' })
        markersRef.current.push(marker)
      })
    }
    map.fitBounds(L.latLngBounds(latlngs).pad(0.2), { maxZoom: 12 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, viewMode])

  // --- selection drives both map and strip ---------------------------------
  const selectItem = useCallback(
    (i: number, opts: { fromMap?: boolean; fromScroll?: boolean } = {}) => {
      setActive(i)
      const map = mapRef.current
      const item = items[i]
      if (map && item) {
        const ll: L.LatLngExpression = [item.gps_lat!, item.gps_lon!]
        map.flyTo(ll, Math.max(map.getZoom(), 14), { duration: 0.6 })
        if (viewMode === 'pins') {
          markersRef.current.forEach((m, idx) =>
            m.setStyle(idx === i ? ACTIVE_STYLE : BASE_STYLE)
          )
          markersRef.current[i]?.bringToFront()
        }
        // A marker at the active spot carries the photo preview tooltip. In heat
        // mode it's also the visible highlight; in pins mode it's invisible and
        // just holds the preview above the red dot.
        const style = viewMode === 'heat' ? ACTIVE_STYLE : INVISIBLE_STYLE
        if (!activeMarkerRef.current) {
          activeMarkerRef.current = L.circleMarker(ll, style).addTo(map)
        } else {
          activeMarkerRef.current.setLatLng(ll).setStyle(style)
        }
        const html = `<img src="${thumbUrl(item.id)}" alt="" /><div class="memora-map-thumb-date">${dateLabel(
          item.taken_at
        )}</div>`
        if (activeMarkerRef.current.getTooltip()) {
          activeMarkerRef.current.setTooltipContent(html)
        } else {
          activeMarkerRef.current.bindTooltip(html, {
            permanent: true,
            direction: 'top',
            offset: [0, -6],
            className: 'memora-map-thumb'
          })
        }
        activeMarkerRef.current.openTooltip()
        activeMarkerRef.current.bringToFront()
      }
      // scroll the strip to this item (unless the scroll itself triggered us)
      if (!opts.fromScroll) {
        suppressScroll.current = true
        const el = stripRef.current?.children[i] as HTMLElement | undefined
        el?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
        setTimeout(() => (suppressScroll.current = false), 500)
      }
    },
    [items, viewMode]
  )

  // --- clicking the heatmap selects the nearest photo ----------------------
  // The heat canvas has no per-point markers, so map clicks find the closest
  // photo (within a pixel threshold) and behave like clicking a pin.
  useEffect(() => {
    const map = mapRef.current
    if (!map || viewMode !== 'heat') return

    const nearest = (latlng: L.LatLng): number => {
      const target = map.latLngToContainerPoint(latlng)
      let best = -1
      let bestDist = 34 // px threshold — ignore clicks on empty map
      items.forEach((it, i) => {
        const p = map.latLngToContainerPoint([it.gps_lat!, it.gps_lon!])
        const dist = target.distanceTo(p)
        if (dist < bestDist) {
          bestDist = dist
          best = i
        }
      })
      return best
    }

    const onClick = (e: L.LeafletMouseEvent): void => {
      const idx = nearest(e.latlng)
      if (idx >= 0) selectItem(idx, { fromMap: true })
    }
    const onDbl = (e: L.LeafletMouseEvent): void => {
      const idx = nearest(e.latlng)
      if (idx >= 0) setViewerIndex(idx)
    }
    map.on('click', onClick)
    map.on('dblclick', onDbl)
    return () => {
      map.off('click', onClick)
      map.off('dblclick', onDbl)
    }
  }, [viewMode, items, selectItem])

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
          <Box sx={{ flex: 1 }} />
          <ToggleButtonGroup
            size="small"
            exclusive
            value={viewMode}
            onChange={(_, v) => v && setViewMode(v)}
          >
            <ToggleButton value="heat">Heatmap</ToggleButton>
            <ToggleButton value="pins">Pins</ToggleButton>
          </ToggleButtonGroup>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={sort}
            onChange={(_, v) => v && setSort(v)}
          >
            <ToggleButton value="newest">Newest first</ToggleButton>
            <ToggleButton value="oldest">Oldest first</ToggleButton>
          </ToggleButtonGroup>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {viewMode === 'heat'
            ? 'Warmer areas hold more photos. Scroll the timeline to fly to where each photo was taken; double-click a photo to open it.'
            : 'Scroll the timeline to fly the map to where each photo was taken. Click a map pin to jump the timeline. Double-click a photo to open it.'}
        </Typography>
      </Box>

      {/* Interactive map */}
      <Box sx={{ flex: 1, minHeight: 0, position: 'relative', mx: 3, borderRadius: 3, overflow: 'hidden' }}>
        <Box ref={mapElRef} sx={{ position: 'absolute', inset: 0 }} />

        {/* Heatmap intensity legend */}
        {viewMode === 'heat' && items.length > 0 && (
          <Box
            sx={{
              position: 'absolute',
              left: 12,
              bottom: 12,
              zIndex: 500,
              px: 1.25,
              py: 1,
              borderRadius: 2,
              bgcolor: 'background.paper',
              boxShadow: 3,
              display: 'flex',
              flexDirection: 'column',
              gap: 0.5,
              width: 148
            }}
          >
            <Typography variant="caption" sx={{ fontWeight: 600 }}>
              Photo density
            </Typography>
            <Box
              sx={{
                height: 8,
                borderRadius: 1,
                background:
                  'linear-gradient(90deg, #2980b9, #16a085, #f1c40f, #e67e22, #e74c3c)'
              }}
            />
            <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
              <Typography variant="caption" color="text.secondary">
                Fewer
              </Typography>
              <Typography variant="caption" color="text.secondary">
                More
              </Typography>
            </Box>
          </Box>
        )}
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
