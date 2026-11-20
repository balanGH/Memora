/**
 * Relationship types and pure graph helpers for the People graph.
 *
 * Kept free of React/MUI so it can be unit-tested (relationTypes.test.ts).
 * The type list mirrors the backend's RELATION_KINDS (backend/app/db.py),
 * which validates every save.
 */
import type { RelationEdge, RelationGraph, RelationInput, RelationKind } from '../api/types'

export interface Preset {
  kind: RelationKind
  /** Button text in the editor. */
  title: string
  /** Short noun used on edges and chips. */
  short: string
  /** null = the user picks the direction (custom). */
  directed: boolean | null
  color: string
}

export const PRESETS: Preset[] = [
  { kind: 'parent', title: 'Parent of', short: 'parent', directed: true, color: '#e57373' },
  { kind: 'child', title: 'Child of', short: 'child', directed: true, color: '#e57373' },
  { kind: 'spouse', title: 'Spouse', short: 'spouse', directed: false, color: '#ba68c8' },
  { kind: 'sibling', title: 'Sibling', short: 'sibling', directed: false, color: '#4fc3f7' },
  { kind: 'relative', title: 'Relative', short: 'relative', directed: false, color: '#4dd0e1' },
  { kind: 'friend', title: 'Friend', short: 'friend', directed: false, color: '#81c784' },
  { kind: 'colleague', title: 'Colleague', short: 'colleague', directed: false, color: '#ffb74d' },
  { kind: 'custom', title: 'Custom', short: '', directed: null, color: '#8ab4f8' }
]

export const KIND_KEYS = PRESETS.map((p) => p.kind)
export const MAX_LABEL = 60

const OTHER_COLOR = '#8ab4f8'

// Free-text custom labels that clearly belong to a colour family.
const COLOR_BY_WORD: Record<string, string> = {
  mother: '#e57373', father: '#e57373', mom: '#e57373', dad: '#e57373',
  son: '#e57373', daughter: '#e57373',
  wife: '#ba68c8', husband: '#ba68c8', partner: '#ba68c8',
  brother: '#4fc3f7', sister: '#4fc3f7',
  cousin: '#4dd0e1', aunt: '#4dd0e1', uncle: '#4dd0e1', niece: '#4dd0e1', nephew: '#4dd0e1',
  grandmother: '#4dd0e1', grandfather: '#4dd0e1'
}

export function presetFor(kind: RelationKind | undefined): Preset {
  return PRESETS.find((p) => p.kind === kind) ?? PRESETS[PRESETS.length - 1]
}

/** Edge kind, inferring it for edges saved before kinds existed. */
export function edgeKind(edge: Pick<RelationEdge, 'kind' | 'label' | 'directed'>): RelationKind {
  if (edge.kind) return edge.kind
  const word = (edge.label || '').trim().toLowerCase()
  const p = PRESETS.find((x) => x.kind === word && x.kind !== 'custom')
  return p && p.directed === !!edge.directed ? p.kind : 'custom'
}

export function edgeColor(edge: Pick<RelationEdge, 'kind' | 'label' | 'directed'>): string {
  const kind = edgeKind(edge)
  if (kind !== 'custom') return presetFor(kind).color
  return COLOR_BY_WORD[(edge.label || '').trim().toLowerCase()] ?? OTHER_COLOR
}

/** Text shown on an edge / chip. */
export function edgeLabel(edge: Pick<RelationEdge, 'kind' | 'label' | 'directed'>): string {
  const kind = edgeKind(edge)
  return kind === 'custom' ? edge.label || 'related' : presetFor(kind).short
}

export interface Draft {
  a: number | null
  b: number | null
  kind: RelationKind
  label: string
  directed: boolean
}

/** First validation problem with a draft, or null if it can be saved.
 *  Mirrors the backend rules so the Save button can explain itself. */
export function draftError(d: Draft): string | null {
  if (d.a == null || d.b == null) return 'Pick both people'
  if (d.a === d.b) return "A person can't be related to themselves"
  if (!KIND_KEYS.includes(d.kind)) return 'Pick a relationship type'
  if (d.kind === 'custom') {
    const label = d.label.trim()
    if (!label) return 'Enter a label for the custom relationship'
    if (label.length > MAX_LABEL) return `Label is too long (max ${MAX_LABEL})`
  }
  return null
}

export function draftToInput(d: Draft): RelationInput {
  const custom = d.kind === 'custom'
  return {
    person_a: d.a as number,
    person_b: d.b as number,
    kind: d.kind,
    ...(custom ? { label: d.label.trim(), directed: d.directed } : {})
  }
}

export function edgeToDraft(e: RelationEdge): Draft {
  const kind = edgeKind(e)
  return {
    a: e.person_a,
    b: e.person_b,
    kind,
    label: kind === 'custom' ? e.label : '',
    directed: !!e.directed
  }
}

export interface GraphFilter {
  /** Case-insensitive name search ('' = everyone). */
  query: string
  /** Relationship kinds to show (empty = all). */
  kinds: RelationKind[]
}

/**
 * Apply search + type filters.
 *
 * Kind filter keeps edges of the chosen types. A name search keeps every
 * person whose name matches *and their direct connections*, so the matched
 * person is shown in context rather than as an isolated dot. People left
 * with no visible edge are dropped (the graph only shows connected people).
 */
export function filterGraph(graph: RelationGraph, f: GraphFilter): RelationGraph {
  let edges = graph.edges
  if (f.kinds.length > 0) {
    const allowed = new Set(f.kinds)
    edges = edges.filter((e) => allowed.has(edgeKind(e)))
  }
  const q = f.query.trim().toLowerCase()
  if (q) {
    const hits = new Set(
      graph.nodes
        .filter((n) => (n.name ?? `unnamed #${n.id}`).toLowerCase().includes(q))
        .map((n) => n.id)
    )
    edges = edges.filter((e) => hits.has(e.person_a) || hits.has(e.person_b))
  }
  const visible = new Set<number>()
  for (const e of edges) {
    visible.add(e.person_a)
    visible.add(e.person_b)
  }
  return { nodes: graph.nodes.filter((n) => visible.has(n.id)), edges }
}

/** Ids of people matched by the search (for highlighting in the graph). */
export function matchingIds(graph: RelationGraph, query: string): Set<number> {
  const q = query.trim().toLowerCase()
  if (!q) return new Set()
  return new Set(
    graph.nodes
      .filter((n) => (n.name ?? `unnamed #${n.id}`).toLowerCase().includes(q))
      .map((n) => n.id)
  )
}
