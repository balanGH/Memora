/**
 * Offline world-map helpers: projects bundled GeoJSON country geometry to SVG
 * path strings (equirectangular), and maps a photo count to a heat color.
 *
 * The map is drawn on a 360×180 canvas where 1 unit = 1 degree, so a lon/lat
 * point projects to [lon + 180, 90 - lat] — matching the markers in PlacesPage.
 */
import countries from '../assets/countries.geo.json'

type Ring = number[][]
type Poly = Ring[]

interface Feature {
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: Poly | Poly[] }
}

const project = (lon: number, lat: number): [number, number] => [lon + 180, 90 - lat]

function ringToPath(ring: Ring): string {
  let d = ''
  for (let i = 0; i < ring.length; i++) {
    const [lon, lat] = ring[i]
    const [x, y] = project(lon, lat)
    d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2)
  }
  return d + 'Z'
}

/** One combined SVG path `d` string for all land, computed once at module load. */
export const WORLD_LAND_PATH: string = (() => {
  const parts: string[] = []
  for (const f of (countries as { features: Feature[] }).features) {
    const { type, coordinates } = f.geometry
    const polys = (type === 'Polygon' ? [coordinates] : coordinates) as Poly[]
    for (const poly of polys) for (const ring of poly) parts.push(ringToPath(ring))
  }
  return parts.join(' ')
})()

/**
 * Heat color for a photo-count intensity t in [0, 1]: cool (few) → hot (many).
 * Stops: teal → green → amber → orange → red.
 */
export function heatColor(t: number): string {
  const stops: [number, [number, number, number]][] = [
    [0.0, [38, 166, 154]], // teal
    [0.35, [124, 179, 66]], // green
    [0.6, [255, 193, 7]], // amber
    [0.8, [251, 140, 0]], // orange
    [1.0, [211, 47, 47]] // red
  ]
  const x = Math.max(0, Math.min(1, t))
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [t0, c0] = stops[i - 1]
      const [t1, c1] = stops[i]
      const f = (x - t0) / (t1 - t0 || 1)
      const c = c0.map((v, k) => Math.round(v + (c1[k] - v) * f))
      return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
    }
  }
  return 'rgb(211,47,47)'
}
