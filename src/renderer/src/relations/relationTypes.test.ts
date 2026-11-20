import { describe, expect, it } from 'vitest'
import type { RelationEdge, RelationGraph } from '../api/types'
import {
  KIND_KEYS,
  PRESETS,
  draftError,
  draftToInput,
  edgeColor,
  edgeKind,
  edgeLabel,
  edgeToDraft,
  filterGraph,
  matchingIds
} from './relationTypes'

const edge = (o: Partial<RelationEdge>): RelationEdge => ({
  id: 1,
  person_a: 1,
  person_b: 2,
  label: 'friend',
  directed: 0,
  ...o
})

describe('relationship types', () => {
  it('offers exactly the types the backend accepts', () => {
    // Must match RELATION_KINDS in backend/app/db.py
    expect(KIND_KEYS.sort()).toEqual(
      ['child', 'colleague', 'custom', 'friend', 'parent', 'relative', 'sibling', 'spouse'].sort()
    )
  })

  it('parent and child are directional, others symmetric, custom user-chosen', () => {
    const dir = Object.fromEntries(PRESETS.map((p) => [p.kind, p.directed]))
    expect(dir).toMatchObject({
      parent: true,
      child: true,
      spouse: false,
      sibling: false,
      relative: false,
      friend: false,
      colleague: false,
      custom: null
    })
  })
})

describe('edge display', () => {
  it('uses the stored kind', () => {
    expect(edgeKind(edge({ kind: 'relative', label: 'relative' }))).toBe('relative')
    expect(edgeLabel(edge({ kind: 'spouse', label: 'spouse' }))).toBe('spouse')
  })

  it('infers the kind for edges saved before kinds existed', () => {
    expect(edgeKind(edge({ label: 'Sibling' }))).toBe('sibling')
    expect(edgeKind(edge({ label: 'parent', directed: 1 }))).toBe('parent')
    // a directed "friend" is not the symmetric preset
    expect(edgeKind(edge({ label: 'friend', directed: 1 }))).toBe('custom')
    expect(edgeKind(edge({ label: 'appears with' }))).toBe('custom')
  })

  it('shows custom labels verbatim and colours known words', () => {
    expect(edgeLabel(edge({ kind: 'custom', label: 'mentor' }))).toBe('mentor')
    expect(edgeLabel(edge({ kind: 'custom', label: '' }))).toBe('related')
    expect(edgeColor(edge({ kind: 'custom', label: 'Cousin' }))).toBe('#4dd0e1')
    expect(edgeColor(edge({ kind: 'parent', label: 'parent' }))).toBe('#e57373')
  })
})

describe('drafts', () => {
  const base = { a: 1, b: 2, kind: 'friend' as const, label: '', directed: false }

  it('validates like the backend', () => {
    expect(draftError(base)).toBeNull()
    expect(draftError({ ...base, b: null })).toMatch(/both people/)
    expect(draftError({ ...base, b: 1 })).toMatch(/themselves/)
    expect(draftError({ ...base, kind: 'custom', label: '   ' })).toMatch(/label/)
    expect(draftError({ ...base, kind: 'custom', label: 'x'.repeat(61) })).toMatch(/too long/)
    expect(draftError({ ...base, kind: 'custom', label: 'mentor' })).toBeNull()
  })

  it('sends label/direction only for custom types', () => {
    expect(draftToInput(base)).toEqual({ person_a: 1, person_b: 2, kind: 'friend' })
    expect(draftToInput({ ...base, kind: 'custom', label: ' mentor ', directed: true })).toEqual({
      person_a: 1,
      person_b: 2,
      kind: 'custom',
      label: 'mentor',
      directed: true
    })
  })

  it('round-trips an existing edge into the editor', () => {
    expect(edgeToDraft(edge({ id: 5, kind: 'parent', label: 'parent', directed: 1 }))).toEqual({
      a: 1,
      b: 2,
      kind: 'parent',
      label: '',
      directed: true
    })
    expect(edgeToDraft(edge({ kind: 'custom', label: 'mentor', directed: 1 })).label).toBe('mentor')
  })
})

describe('search and filtering', () => {
  const graph: RelationGraph = {
    nodes: [
      { id: 1, name: 'Ann', cover_media_id: null },
      { id: 2, name: 'Bob', cover_media_id: null },
      { id: 3, name: 'Cara', cover_media_id: null },
      { id: 4, name: null, cover_media_id: null }
    ],
    edges: [
      edge({ id: 10, person_a: 1, person_b: 2, kind: 'spouse', label: 'spouse' }),
      edge({ id: 11, person_a: 1, person_b: 3, kind: 'parent', label: 'parent', directed: 1 }),
      edge({ id: 12, person_a: 3, person_b: 4, kind: 'friend', label: 'friend' })
    ]
  }

  it('returns everything without filters', () => {
    expect(filterGraph(graph, { query: '', kinds: [] })).toEqual(graph)
  })

  it('filters by relationship type and drops unconnected people', () => {
    const r = filterGraph(graph, { query: '', kinds: ['spouse'] })
    expect(r.edges.map((e) => e.id)).toEqual([10])
    expect(r.nodes.map((n) => n.id)).toEqual([1, 2])
  })

  it('name search keeps matches with their direct connections', () => {
    const r = filterGraph(graph, { query: 'bo', kinds: [] })
    expect(r.edges.map((e) => e.id)).toEqual([10])
    expect(r.nodes.map((n) => n.id).sort()).toEqual([1, 2])
    expect([...matchingIds(graph, 'bo')]).toEqual([2])
  })

  it('search is case-insensitive and finds unnamed people by id', () => {
    expect(filterGraph(graph, { query: 'CARA', kinds: [] }).edges.map((e) => e.id)).toEqual([11, 12])
    expect([...matchingIds(graph, 'unnamed #4')]).toEqual([4])
  })

  it('combines search and type filters', () => {
    const r = filterGraph(graph, { query: 'cara', kinds: ['friend'] })
    expect(r.edges.map((e) => e.id)).toEqual([12])
  })
})
