import { useCallback, useEffect, useRef, useState } from 'react'
import { personFaceUrl } from '../api/client'

export interface GNode {
  id: number
  name: string | null
  photo_count?: number
}
export interface GEdge {
  id: number
  a: number
  b: number
  label: string
  directed: boolean
}

interface Props {
  nodes: GNode[]
  edges: GEdge[]
  onOpen: (id: number) => void
  edgeColor: (label: string) => string
  /** Bump this to recenter the view (reset pan/zoom) and re-settle the layout. */
  resetSignal?: number
  /** 'force' = physics graph; 'tree' = layered generations (parent above child). */
  layout?: 'force' | 'tree'
}

/** Layered tree layout: directed (parent->child) edges set generations; nodes
 *  joined only by undirected links (spouse/sibling/friend) share a level. */
function treeLayout(nodes: GNode[], edges: GEdge[]): Map<number, { x: number; y: number }> {
  const ids = nodes.map((n) => n.id)
  const level = new Map<number, number>(ids.map((id) => [id, 0]))

  // Longest-path levelling along parent->child edges.
  for (let iter = 0; iter < ids.length + 1; iter++) {
    let changed = false
    for (const e of edges) {
      if (!e.directed) continue
      const nl = (level.get(e.a) ?? 0) + 1
      if (nl > (level.get(e.b) ?? 0)) {
        level.set(e.b, nl)
        changed = true
      }
    }
    if (!changed) break
  }
  // Pull same-level relations (friend/sibling/spouse) onto one row.
  for (let iter = 0; iter < ids.length + 1; iter++) {
    let changed = false
    for (const e of edges) {
      if (e.directed) continue
      const m = Math.max(level.get(e.a) ?? 0, level.get(e.b) ?? 0)
      if ((level.get(e.a) ?? 0) !== m) {
        level.set(e.a, m)
        changed = true
      }
      if ((level.get(e.b) ?? 0) !== m) {
        level.set(e.b, m)
        changed = true
      }
    }
    if (!changed) break
  }

  const byLevel = new Map<number, number[]>()
  ids.forEach((id) => {
    const l = level.get(id) ?? 0
    if (!byLevel.has(l)) byLevel.set(l, [])
    byLevel.get(l)!.push(id)
  })

  const ROW_H = 150
  const COL_W = 130
  const levels = [...byLevel.keys()].sort((a, b) => a - b)
  const maxL = levels.length ? levels[levels.length - 1] : 0
  const out = new Map<number, { x: number; y: number }>()
  // Order each row near parents' x to reduce edge crossings.
  for (const l of levels) {
    const row = byLevel.get(l)!
    row.sort((n1, n2) => {
      const px = (id: number): number => {
        const parents = edges
          .filter((e) => e.directed && e.b === id && out.has(e.a))
          .map((e) => out.get(e.a)!.x)
        return parents.length ? parents.reduce((s, x) => s + x, 0) / parents.length : 0
      }
      return px(n1) - px(n2)
    })
    row.forEach((id, i) => {
      out.set(id, {
        x: (i - (row.length - 1) / 2) * COL_W,
        y: (l - maxL / 2) * ROW_H
      })
    })
  }
  return out
}

interface P {
  x: number
  y: number
  vx: number
  vy: number
}

const W = 900
const H = 620
// simulation constants
const REPULSION = 9000
const SPRING = 0.015
const REST = 130
const CENTER = 0.006
const DAMP = 0.82
// Directed (parent->child) edges get a vertical bias so generations stack
// top-to-bottom, giving family chains a tree-like hierarchy.
const HIER_GAP = 100
const HIER_K = 0.07

function radiusOf(n: GNode): number {
  return 16 + Math.min(n.photo_count ?? 0, 12) * 1.4
}

export default function ForceGraph({
  nodes,
  edges,
  onOpen,
  edgeColor,
  resetSignal = 0,
  layout = 'force'
}: Props): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null)
  const pos = useRef<Map<number, P>>(new Map())
  const raf = useRef<number | null>(null)
  const alphaRef = useRef(1)
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  // Apply the static tree layout into the position map.
  const applyTree = useCallback(() => {
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current)
      raf.current = null
    }
    const tl = treeLayout(nodes, edges)
    const map = pos.current
    tl.forEach((p, id) => map.set(id, { x: p.x, y: p.y, vx: 0, vy: 0 }))
    setFrame((f) => f + 1)
  }, [nodes, edges])

  const dragId = useRef<number | null>(null)
  const dragged = useRef(false)
  const panning = useRef<{ x: number; y: number } | null>(null)
  const [, setFrame] = useState(0)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [hover, setHover] = useState<number | null>(null)

  // keep positions in sync with the node set
  useEffect(() => {
    const map = pos.current
    const ids = new Set(nodes.map((n) => n.id))
    for (const id of [...map.keys()]) if (!ids.has(id)) map.delete(id)
    nodes.forEach((n, i) => {
      if (!map.has(n.id)) {
        const ang = (2 * Math.PI * i) / Math.max(nodes.length, 1)
        map.set(n.id, { x: Math.cos(ang) * 160, y: Math.sin(ang) * 160, vx: 0, vy: 0 })
      }
    })
    if (layout === 'tree') {
      applyTree()
    } else {
      alphaRef.current = 1
      start()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, layout])

  const tick = useCallback(() => {
    const map = pos.current
    const list = nodes.map((n) => n.id)
    const fx = new Map<number, number>()
    const fy = new Map<number, number>()
    list.forEach((id) => {
      fx.set(id, 0)
      fy.set(id, 0)
    })

    // pairwise repulsion
    for (let i = 0; i < list.length; i++) {
      const a = map.get(list[i])!
      for (let j = i + 1; j < list.length; j++) {
        const b = map.get(list[j])!
        let dx = a.x - b.x
        let dy = a.y - b.y
        let d2 = dx * dx + dy * dy || 0.01
        const f = REPULSION / d2
        const d = Math.sqrt(d2)
        dx /= d
        dy /= d
        fx.set(list[i], fx.get(list[i])! + dx * f)
        fy.set(list[i], fy.get(list[i])! + dy * f)
        fx.set(list[j], fx.get(list[j])! - dx * f)
        fy.set(list[j], fy.get(list[j])! - dy * f)
      }
    }
    // edge springs
    for (const e of edges) {
      const a = map.get(e.a)
      const b = map.get(e.b)
      if (!a || !b) continue
      let dx = b.x - a.x
      let dy = b.y - a.y
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01
      const force = (d - REST) * SPRING
      dx = (dx / d) * force
      dy = (dy / d) * force
      fx.set(e.a, fx.get(e.a)! + dx)
      fy.set(e.a, fy.get(e.a)! + dy)
      fx.set(e.b, fx.get(e.b)! - dx)
      fy.set(e.b, fy.get(e.b)! - dy)
      // hierarchy: keep the child (e.b) about HIER_GAP below the parent (e.a)
      if (e.directed) {
        const err = b.y - a.y - HIER_GAP
        fy.set(e.a, fy.get(e.a)! + err * HIER_K)
        fy.set(e.b, fy.get(e.b)! - err * HIER_K)
      }
    }

    let maxV = 0
    const alpha = alphaRef.current
    for (const id of list) {
      if (id === dragId.current) continue
      const p = map.get(id)!
      const ax = fx.get(id)! - p.x * CENTER
      const ay = fy.get(id)! - p.y * CENTER
      p.vx = (p.vx + ax) * DAMP
      p.vy = (p.vy + ay) * DAMP
      p.x += p.vx * alpha
      p.y += p.vy * alpha
      maxV = Math.max(maxV, Math.abs(p.vx), Math.abs(p.vy))
    }
    alphaRef.current = Math.max(alpha * 0.99, 0.05)

    setFrame((f) => f + 1)
    if (maxV < 0.08 && dragId.current === null) {
      raf.current = null // settled — stop looping
    } else {
      raf.current = requestAnimationFrame(tick)
    }
  }, [nodes, edges])

  const start = useCallback(() => {
    if (layoutRef.current === 'tree') return // tree layout is static
    if (raf.current === null) raf.current = requestAnimationFrame(tick)
  }, [tick])

  useEffect(() => {
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current)
    }
  }, [])

  // Recenter: reset pan/zoom, re-pull nodes toward the middle, and re-settle.
  useEffect(() => {
    if (resetSignal === 0) return
    setPan({ x: 0, y: 0 })
    setZoom(1)
    if (layout === 'tree') {
      applyTree()
      return
    }
    const map = pos.current
    nodes.forEach((n, i) => {
      const p = map.get(n.id)
      if (p) {
        const ang = (2 * Math.PI * i) / Math.max(nodes.length, 1)
        p.x = Math.cos(ang) * 160
        p.y = Math.sin(ang) * 160
        p.vx = 0
        p.vy = 0
      }
    })
    alphaRef.current = 1
    start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal])

  // ---- coordinate helpers -------------------------------------------------
  const toGraph = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = svgRef.current!.getBoundingClientRect()
    const sx = ((clientX - rect.left) / rect.width) * W
    const sy = ((clientY - rect.top) / rect.height) * H
    return { x: (sx - W / 2 - pan.x) / zoom, y: (sy - H / 2 - pan.y) / zoom }
  }

  // ---- interactions -------------------------------------------------------
  const onNodeDown = (e: React.PointerEvent, id: number): void => {
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    dragId.current = id
    dragged.current = false
    alphaRef.current = 0.6
    start()
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    if (dragId.current !== null) {
      const g = toGraph(e.clientX, e.clientY)
      const p = pos.current.get(dragId.current)
      if (p) {
        p.x = g.x
        p.y = g.y
        p.vx = 0
        p.vy = 0
      }
      dragged.current = true
      setFrame((f) => f + 1)
    } else if (panning.current) {
      setPan({ x: e.clientX - panning.current.x, y: e.clientY - panning.current.y })
    }
  }
  const endDrag = (): void => {
    if (dragId.current !== null) {
      dragId.current = null
      alphaRef.current = Math.max(alphaRef.current, 0.4)
      start()
    }
    panning.current = null
  }
  const onBgDown = (e: React.PointerEvent): void => {
    panning.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
  }
  const onWheel = (e: React.WheelEvent): void => {
    const factor = e.deltaY < 0 ? 1.12 : 0.89
    const next = Math.min(Math.max(zoom * factor, 0.3), 3)
    const rect = svgRef.current!.getBoundingClientRect()
    const cx = ((e.clientX - rect.left) / rect.width) * W - W / 2
    const cy = ((e.clientY - rect.top) / rect.height) * H - H / 2
    const gx = (cx - pan.x) / zoom
    const gy = (cy - pan.y) / zoom
    setPan({ x: cx - gx * next, y: cy - gy * next })
    setZoom(next)
  }

  const neighbors = (id: number): Set<number> => {
    const s = new Set<number>([id])
    edges.forEach((e) => {
      if (e.a === id) s.add(e.b)
      if (e.b === id) s.add(e.a)
    })
    return s
  }
  const active = hover !== null ? neighbors(hover) : null
  const dim = (id: number): number => (active && !active.has(id) ? 0.15 : 1)
  const edgeDim = (e: GEdge): number =>
    active && !(active.has(e.a) && active.has(e.b)) ? 0.08 : 1

  const map = pos.current

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', height: H, display: 'block', touchAction: 'none', cursor: panning.current ? 'grabbing' : 'grab' }}
      onPointerDown={onBgDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
      onWheel={onWheel}
    >
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
        </marker>
      </defs>

      <g transform={`translate(${W / 2 + pan.x},${H / 2 + pan.y}) scale(${zoom})`}>
        {/* edges */}
        {edges.map((e) => {
          const a = map.get(e.a)
          const b = map.get(e.b)
          if (!a || !b) return null
          const col = edgeColor(e.label)
          const mx = (a.x + b.x) / 2
          const my = (a.y + b.y) / 2
          return (
            <g key={e.id} opacity={edgeDim(e)}>
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={col}
                strokeWidth={2}
                strokeOpacity={0.75}
                markerEnd={e.directed ? 'url(#arrow)' : undefined}
              />
              {e.label && (
                <text
                  x={mx}
                  y={my - 4}
                  textAnchor="middle"
                  fontSize={11}
                  fontWeight={600}
                  fill={col}
                  style={{ pointerEvents: 'none' }}
                >
                  {e.label}
                </text>
              )}
            </g>
          )
        })}

        {/* nodes */}
        {nodes.map((n) => {
          const p = map.get(n.id)
          if (!p) return null
          const r = radiusOf(n)
          return (
            <g
              key={n.id}
              opacity={dim(n.id)}
              style={{ cursor: 'pointer' }}
              onPointerDown={(e) => onNodeDown(e, n.id)}
              onPointerUp={() => {
                if (!dragged.current) onOpen(n.id)
              }}
              onPointerEnter={() => setHover(n.id)}
              onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
            >
              <clipPath id={`fg-clip-${n.id}`}>
                <circle cx={p.x} cy={p.y} r={r} />
              </clipPath>
              <circle cx={p.x} cy={p.y} r={r} fill="#5f6368" />
              <image
                href={personFaceUrl(n.id)}
                x={p.x - r}
                y={p.y - r}
                width={r * 2}
                height={r * 2}
                clipPath={`url(#fg-clip-${n.id})`}
                preserveAspectRatio="xMidYMid slice"
              />
              <circle
                cx={p.x}
                cy={p.y}
                r={r}
                fill="none"
                stroke={hover === n.id ? '#8ab4f8' : '#ffffff'}
                strokeWidth={hover === n.id ? 3 : 2}
              />
              <text
                x={p.x}
                y={p.y + r + 14}
                textAnchor="middle"
                fontSize={12}
                fontWeight={600}
                fill="currentColor"
              >
                {(n.name ?? 'Unnamed').slice(0, 16)}
              </text>
            </g>
          )
        })}
      </g>
    </svg>
  )
}
