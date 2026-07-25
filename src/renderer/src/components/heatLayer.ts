import L from 'leaflet'

/** One weighted point on the heatmap. `value` defaults to 1; overlapping
 *  points accumulate, so denser places (more photos) glow hotter. */
export interface HeatPoint {
  lat: number
  lng: number
  value?: number
}

export interface HeatOptions {
  radius?: number
  blur?: number
  minOpacity?: number
  max?: number
  /** Zoom at which `radius` is used as-is. Below it the brush shrinks, above it
   *  it grows, so a point covers a consistent area on the ground instead of a
   *  fixed pixel size (which looks like a giant bubble when zoomed out). */
  refZoom?: number
  /** Clamp the zoom scaling so points never vanish or balloon. */
  minScale?: number
  maxScale?: number
  /** offset 0..1 -> CSS color stops, low intensity to high. */
  gradient?: Record<number, string>
}

const DEFAULT_GRADIENT: Record<number, string> = {
  0.0: 'rgba(41,128,185,0)',
  0.2: '#2980b9',
  0.4: '#16a085',
  0.6: '#f1c40f',
  0.8: '#e67e22',
  1.0: '#e74c3c'
}

// A minimal, dependency-free heatmap layer for Leaflet (canvas overlay). The
// approach mirrors simpleheat: stamp a soft radial brush per point into an
// alpha-accumulating canvas, then recolor by mapping alpha -> gradient palette.
const HeatLayerClass = (L.Layer as unknown as { extend: (o: object) => unknown }).extend({
  initialize(this: any, points: HeatPoint[], options?: HeatOptions) {
    this._points = points || []
    L.Util.setOptions(this, {
      radius: 28,
      blur: 18,
      minOpacity: 0.3,
      max: 1,
      refZoom: 14,
      minScale: 0.25,
      maxScale: 1.4,
      gradient: DEFAULT_GRADIENT,
      ...options
    })
  },

  setPoints(this: any, points: HeatPoint[]) {
    this._points = points || []
    this._redraw()
    return this
  },

  onAdd(this: any, map: L.Map) {
    this._map = map
    if (!this._canvas) this._initCanvas()
    map.getPanes().overlayPane.appendChild(this._canvas)
    map.on('moveend', this._reset, this)
    if (map.options.zoomAnimation && L.Browser.any3d) {
      map.on('zoomanim', this._animateZoom, this)
    }
    this._reset()
  },

  onRemove(this: any, map: L.Map) {
    map.getPanes().overlayPane.removeChild(this._canvas)
    map.off('moveend', this._reset, this)
    map.off('zoomanim', this._animateZoom, this)
  },

  _initCanvas(this: any) {
    const canvas = (this._canvas = L.DomUtil.create(
      'canvas',
      'leaflet-heat-layer leaflet-layer'
    ) as HTMLCanvasElement)
    const size = this._map.getSize()
    canvas.width = size.x
    canvas.height = size.y
    const animated = this._map.options.zoomAnimation && L.Browser.any3d
    L.DomUtil.addClass(canvas, 'leaflet-zoom-' + (animated ? 'animated' : 'hide'))
    this._ctx = canvas.getContext('2d')
    this._brush = this._buildBrush()
    this._grad = this._buildGradient()
  },

  _buildBrush(this: any): HTMLCanvasElement {
    const r = this.options.radius + this.options.blur
    const brush = document.createElement('canvas')
    brush.width = brush.height = r * 2
    const ctx = brush.getContext('2d')!
    const g = ctx.createRadialGradient(r, r, 0, r, r, r)
    g.addColorStop(0, 'rgba(0,0,0,1)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(r, r, r, 0, Math.PI * 2, true)
    ctx.fill()
    return brush
  },

  _buildGradient(this: any): Uint8ClampedArray {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 256
    const ctx = canvas.getContext('2d')!
    const g = ctx.createLinearGradient(0, 0, 0, 256)
    const stops = this.options.gradient as Record<number, string>
    for (const stop of Object.keys(stops)) g.addColorStop(Number(stop), stops[Number(stop)])
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 1, 256)
    return ctx.getImageData(0, 0, 1, 256).data
  },

  _reset(this: any) {
    const topLeft = this._map.containerPointToLayerPoint([0, 0])
    L.DomUtil.setPosition(this._canvas, topLeft)
    const size = this._map.getSize()
    if (this._canvas.width !== size.x) this._canvas.width = size.x
    if (this._canvas.height !== size.y) this._canvas.height = size.y
    this._redraw()
  },

  _animateZoom(this: any, e: { zoom: number; center: L.LatLng }) {
    const scale = this._map.getZoomScale(e.zoom)
    const offset = (this._map as any)
      ._getCenterOffset(e.center)
      ._multiplyBy(-scale)
      .subtract((this._map as any)._getMapPanePos())
    L.DomUtil.setTransform(this._canvas, offset, scale)
  },

  _redraw(this: any) {
    if (!this._map || !this._ctx) return
    const ctx = this._ctx as CanvasRenderingContext2D
    const size = this._map.getSize()
    ctx.clearRect(0, 0, size.x, size.y)
    const max = this.options.max || 1

    // Scale the brush by zoom so a point maps to a consistent ground area:
    // each zoom level doubles the pixels-per-metre, so scale by 2^(zoom-ref),
    // clamped so points never disappear or balloon.
    const scale = Math.min(
      Math.max(
        Math.pow(2, this._map.getZoom() - this.options.refZoom),
        this.options.minScale
      ),
      this.options.maxScale
    )
    const r0 = this.options.radius + this.options.blur
    const r = r0 * scale
    const d = r * 2

    for (const p of this._points as HeatPoint[]) {
      const pt = this._map.latLngToContainerPoint([p.lat, p.lng])
      if (pt.x < -r || pt.y < -r || pt.x > size.x + r || pt.y > size.y + r) continue
      ctx.globalAlpha = Math.min(Math.max((p.value ?? 1) / max, this.options.minOpacity), 1)
      ctx.drawImage(this._brush, pt.x - r, pt.y - r, d, d)
    }
    ctx.globalAlpha = 1

    const img = ctx.getImageData(0, 0, size.x, size.y)
    const data = img.data
    const grad = this._grad as Uint8ClampedArray
    for (let i = 0, len = data.length; i < len; i += 4) {
      const a = data[i + 3]
      if (a) {
        const j = a * 4
        data[i] = grad[j]
        data[i + 1] = grad[j + 1]
        data[i + 2] = grad[j + 2]
      }
    }
    ctx.putImageData(img, 0, 0)
  }
})

export function heatLayer(points: HeatPoint[], options?: HeatOptions): L.Layer {
  return new (HeatLayerClass as any)(points, options)
}
