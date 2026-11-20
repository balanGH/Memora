import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box,
  Typography,
  Button,
  Stack,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  MenuItem,
  IconButton,
  Chip,
  Divider,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Avatar,
  Alert,
  Checkbox,
  InputAdornment,
  CircularProgress
} from '@mui/material'
import HubIcon from '@mui/icons-material/Hub'
import AddIcon from '@mui/icons-material/Add'
import DeleteIcon from '@mui/icons-material/Delete'
import EditIcon from '@mui/icons-material/Edit'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import CenterFocusStrongIcon from '@mui/icons-material/CenterFocusStrong'
import FamilyRestroomIcon from '@mui/icons-material/FamilyRestroom'
import SearchIcon from '@mui/icons-material/Search'
import GridViewIcon from '@mui/icons-material/GridView'
import ForceGraph from '../components/ForceGraph'
import { ApiError, api, personFaceUrl } from '../api/client'
import type {
  FamilySuggestion,
  Person,
  RelationEdge,
  RelationGraph,
  RelationKind,
  RelationSuggestion
} from '../api/types'
import { useNotify } from '../context/FeedbackContext'
import {
  PRESETS,
  type Draft,
  draftError,
  draftToInput,
  edgeColor,
  edgeKind,
  edgeLabel,
  edgeToDraft,
  filterGraph,
  matchingIds,
  presetFor
} from '../relations/relationTypes'

const LEGEND = [
  ...PRESETS.filter((p) => p.kind !== 'custom' && p.kind !== 'child').map((p) => ({
    c: p.color,
    t: p.kind === 'parent' ? 'Parent/child' : p.title
  })),
  { c: '#8ab4f8', t: 'Other' }
]

const EMPTY_DRAFT: Draft = { a: null, b: null, kind: 'friend', label: '', directed: false }

function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    const d = e.detail as { message?: string } | string
    return typeof d === 'string' ? d : (d?.message ?? e.message)
  }
  return String(e)
}

export default function RelationsPage(): JSX.Element {
  const navigate = useNavigate()
  const notify = useNotify()
  const [graph, setGraph] = useState<RelationGraph>({ nodes: [], edges: [] })
  const [people, setPeople] = useState<Person[]>([])
  const [suggestions, setSuggestions] = useState<RelationSuggestion[]>([])
  const [family, setFamily] = useState<FamilySuggestion[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // editor
  const [dialog, setDialog] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<RelationEdge | null>(null)

  // graph view
  const [resetSignal, setResetSignal] = useState(0)
  const [graphMode, setGraphMode] = useState<'force' | 'tree'>('force')
  const [query, setQuery] = useState('')
  const [kinds, setKinds] = useState<RelationKind[]>([])
  const [selEdges, setSelEdges] = useState<Set<number>>(new Set())

  // auto-connect (preview → confirm)
  const [autoOpen, setAutoOpen] = useState(false)
  const [minShared, setMinShared] = useState('2')
  const [autoBusy, setAutoBusy] = useState(false)
  const [proposals, setProposals] = useState<RelationSuggestion[] | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    try {
      const [g, s, f, p] = await Promise.all([
        api.relations(),
        api.relationSuggestions(),
        api.familySuggestions(),
        api.people(true)
      ])
      setGraph(g)
      setSuggestions(s.suggestions)
      setFamily(f.suggestions)
      setPeople(p.people)
      setLoadError(null)
    } catch (e) {
      setLoadError(describeError(e))
    } finally {
      setLoaded(true)
    }
  }, [])
  useEffect(() => {
    load()
  }, [load])

  const nameOf = useCallback(
    (id: number): string => {
      const n = graph.nodes.find((x) => x.id === id) ?? people.find((x) => x.id === id)
      return n?.name ?? `Unnamed #${id}`
    },
    [graph.nodes, people]
  )

  // ---- editor -------------------------------------------------------------

  const openDialog = (init: Partial<Draft> = {}): void => {
    setEditingId(null)
    setDraft({ ...EMPTY_DRAFT, ...init })
    setSaveError(null)
    setConflict(null)
    setDialog(true)
  }

  const openEdit = (edge: RelationEdge): void => {
    setEditingId(edge.id)
    setDraft(edgeToDraft(edge))
    setSaveError(null)
    setConflict(null)
    setDialog(true)
  }

  const save = async (replace = false): Promise<void> => {
    const problem = draftError(draft)
    if (problem) {
      setSaveError(problem)
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const input = { ...draftToInput(draft), replace }
      if (editingId !== null) await api.updateRelation(editingId, input)
      else await api.addRelation(input)
      setDialog(false)
      setConflict(null)
      notify(editingId !== null ? 'Relationship updated' : 'Relationship saved')
      load()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const existing = (e.detail as { existing?: RelationEdge })?.existing ?? null
        setConflict(existing)
        setSaveError(
          existing
            ? `${nameOf(existing.person_a)} and ${nameOf(existing.person_b)} are already linked as “${edgeLabel(existing)}”.`
            : describeError(e)
        )
      } else {
        setSaveError(describeError(e))
      }
    } finally {
      setSaving(false)
    }
  }

  const removeRelation = async (id: number): Promise<void> => {
    try {
      await api.deleteRelation(id)
      setSelEdges((prev) => {
        const n = new Set(prev)
        n.delete(id)
        return n
      })
      load()
    } catch (e) {
      notify(`Couldn't delete: ${describeError(e)}`, { severity: 'error' })
    }
  }

  const deleteMany = async (ids: number[]): Promise<void> => {
    try {
      await Promise.all(ids.map((id) => api.deleteRelation(id)))
      notify(`Deleted ${ids.length} relationship${ids.length === 1 ? '' : 's'}`)
    } catch (e) {
      notify(`Some deletions failed: ${describeError(e)}`, { severity: 'error' })
    }
    setSelEdges(new Set())
    load()
  }

  // ---- filtering ----------------------------------------------------------

  const view = useMemo(() => filterGraph(graph, { query, kinds }), [graph, query, kinds])
  const highlight = useMemo(() => matchingIds(graph, query), [graph, query])
  const filtering = query.trim() !== '' || kinds.length > 0
  const toggleKind = (k: RelationKind): void =>
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]))

  const toggleEdgeSel = (id: number): void => {
    setSelEdges((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }
  const allSelected = view.edges.length > 0 && view.edges.every((e) => selEdges.has(e.id))
  const toggleSelectAll = (): void => {
    setSelEdges(allSelected ? new Set() : new Set(view.edges.map((e) => e.id)))
  }

  const clearAll = async (): Promise<void> => {
    if (graph.edges.length === 0) return
    if (!window.confirm(`Delete all ${graph.edges.length} relationships? This can't be undone.`))
      return
    await deleteMany(graph.edges.map((e) => e.id))
  }

  // ---- auto-connect -------------------------------------------------------

  const pairKey = (p: { a: number; b: number }): string => `${p.a}-${p.b}`

  const previewAuto = async (): Promise<void> => {
    setAutoBusy(true)
    try {
      const r = await api.autoConnectPreview(Math.max(1, Number(minShared) || 2))
      setProposals(r.pairs)
      setChosen(new Set())
    } catch (e) {
      notify(`Couldn't load proposals: ${describeError(e)}`, { severity: 'error' })
    } finally {
      setAutoBusy(false)
    }
  }

  const confirmAuto = async (): Promise<void> => {
    const pairs = (proposals ?? []).filter((p) => chosen.has(pairKey(p)))
    if (pairs.length === 0) return
    setAutoBusy(true)
    try {
      const r = await api.autoConnectConfirm(pairs.map((p) => ({ a: p.a, b: p.b })))
      closeAuto()
      notify(`Connected ${r.created} pair${r.created === 1 ? '' : 's'} as “appears with”, edit them to set the type`)
      load()
    } catch (e) {
      notify(`Couldn't connect: ${describeError(e)}`, { severity: 'error' })
    } finally {
      setAutoBusy(false)
    }
  }

  const closeAuto = (): void => {
    setAutoOpen(false)
    setProposals(null)
    setChosen(new Set())
  }

  // ---- rendering helpers --------------------------------------------------

  // Grid of selectable people (avatar + name) used in the editor.
  const renderPeopleGrid = (
    value: number | null,
    onChange: (v: number) => void,
    exclude: number | null
  ): JSX.Element => (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))',
        gap: 1,
        mt: 0.5,
        maxHeight: 200,
        overflow: 'auto',
        p: 0.5
      }}
    >
      {people
        .filter((p) => p.id !== exclude)
        .map((p) => {
          const on = value === p.id
          return (
            <Box
              key={p.id}
              role="button"
              tabIndex={0}
              aria-pressed={on}
              onClick={() => onChange(p.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onChange(p.id)
                }
              }}
              sx={{
                cursor: 'pointer',
                textAlign: 'center',
                p: 0.75,
                borderRadius: 2,
                border: (t) =>
                  on ? `2px solid ${t.palette.primary.main}` : `1px solid ${t.palette.divider}`,
                bgcolor: (t) => (on ? t.palette.action.selected : 'transparent')
              }}
            >
              <Avatar src={personFaceUrl(p.id)} sx={{ width: 44, height: 44, mx: 'auto', mb: 0.5 }} />
              <Typography variant="caption" noWrap sx={{ display: 'block' }}>
                {p.name ?? `Unnamed #${p.id}`}
              </Typography>
            </Box>
          )
        })}
    </Box>
  )

  const gnodes = view.nodes.map((n) => ({ id: n.id, name: n.name, photo_count: n.photo_count }))
  const gedges = view.edges.map((e) => ({
    id: e.id,
    a: e.person_a,
    b: e.person_b,
    label: edgeLabel(e),
    directed: !!e.directed,
    color: edgeColor(e)
  }))
  const preset = presetFor(draft.kind)
  const draftProblem = draftError(draft)

  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: { xs: 2, md: 3 } }}>
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ mb: 0.5, flexWrap: 'wrap', rowGap: 1 }}
      >
        <HubIcon color="primary" />
        <Typography variant="h5" sx={{ fontWeight: 600, flex: 1 }}>
          People graph
        </Typography>
        <ToggleButtonGroup size="small" exclusive value="graph" aria-label="People view">
          <ToggleButton value="people" onClick={() => navigate('/people')}>
            <GridViewIcon fontSize="small" sx={{ mr: 0.5 }} /> People
          </ToggleButton>
          <ToggleButton value="graph">
            <HubIcon fontSize="small" sx={{ mr: 0.5 }} /> Graph
          </ToggleButton>
        </ToggleButtonGroup>
        <Tooltip title="Propose links between people photographed together. You choose which to save.">
          <span>
            <Button
              variant="outlined"
              startIcon={<AutoFixHighIcon />}
              onClick={() => setAutoOpen(true)}
              disabled={people.length < 2}
            >
              Auto-connect
            </Button>
          </span>
        </Tooltip>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => openDialog()}
          disabled={people.length < 2}
        >
          Add relation
        </Button>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Graph or Tree view · drag faces · scroll to zoom · drag the background to pan · click a
        face to open that person&apos;s photos. Nothing is linked unless you save it.
      </Typography>

      {loadError && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => load()}>
              Retry
            </Button>
          }
        >
          Couldn&apos;t load relationships: {loadError}
        </Alert>
      )}

      {/* Family (parent/child) hints from estimated ages: open the editor to confirm */}
      {family.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 0.5 }}>
            <FamilyRestroomIcon fontSize="small" color="primary" />
            <Typography variant="subtitle2">Possible parent → child (by age)</Typography>
          </Stack>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
            {family.map((f) => (
              <Chip
                key={`${f.parent}-${f.child}`}
                onClick={() => openDialog({ a: f.parent, b: f.child, kind: 'parent' })}
                avatar={<Avatar src={personFaceUrl(f.parent)} />}
                label={`${f.parent_name ?? 'Unnamed'} (${f.parent_age}) → ${
                  f.child_name ?? 'Unnamed'
                } (${f.child_age})`}
                variant="outlined"
                color="primary"
                icon={<AddIcon />}
              />
            ))}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            Guessed from face age estimates. Click to review and confirm; nothing is saved
            automatically.
          </Typography>
        </Box>
      )}

      {/* Co-occurrence hints */}
      {suggestions.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 0.5 }}>
            <AutoAwesomeIcon fontSize="small" color="primary" />
            <Typography variant="subtitle2">Often photographed together</Typography>
          </Stack>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
            {suggestions.map((s) => (
              <Chip
                key={`${s.a}-${s.b}`}
                onClick={() => openDialog({ a: s.a, b: s.b })}
                label={`${s.a_name ?? 'Unnamed'} + ${s.b_name ?? 'Unnamed'} · ${s.shared}`}
                variant="outlined"
                icon={<AddIcon />}
              />
            ))}
          </Stack>
        </Box>
      )}

      {!loaded ? (
        <Box sx={{ height: 300, display: 'grid', placeItems: 'center' }}>
          <CircularProgress />
        </Box>
      ) : graph.edges.length === 0 ? (
        <Box
          sx={{
            height: 300,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'text.secondary',
            gap: 1,
            textAlign: 'center'
          }}
        >
          <Typography variant="h6">No relationships yet</Typography>
          <Typography variant="body2">
            {people.length < 2
              ? 'You need at least two people. Let AI processing finish first.'
              : 'Add a relation, or pick a suggestion above.'}
          </Typography>
        </Box>
      ) : (
        <>
          {/* Search + type filters */}
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            alignItems={{ sm: 'center' }}
            sx={{ mb: 1.5 }}
          >
            <TextField
              size="small"
              placeholder="Search people"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              inputProps={{ 'aria-label': 'Search people in the graph' }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                )
              }}
              sx={{ minWidth: 220 }}
            />
            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75 }}>
              {PRESETS.map((p) => {
                const on = kinds.includes(p.kind)
                return (
                  <Chip
                    key={p.kind}
                    size="small"
                    label={p.kind === 'custom' ? 'Custom' : p.title.replace(' of', '')}
                    onClick={() => toggleKind(p.kind)}
                    variant={on ? 'filled' : 'outlined'}
                    aria-pressed={on}
                    sx={on ? { bgcolor: p.color, color: '#111' } : { borderColor: p.color }}
                  />
                )
              })}
              {filtering && (
                <Chip
                  size="small"
                  label="Clear filters"
                  onClick={() => {
                    setQuery('')
                    setKinds([])
                  }}
                />
              )}
            </Stack>
          </Stack>

          <Box
            sx={{
              border: (t) => `1px solid ${t.palette.divider}`,
              borderRadius: 3,
              overflow: 'hidden',
              position: 'relative',
              bgcolor: (t) => (t.palette.mode === 'dark' ? '#15171c' : '#fafafa')
            }}
          >
            {view.edges.length === 0 ? (
              <Box sx={{ height: 300, display: 'grid', placeItems: 'center', color: 'text.secondary' }}>
                <Typography variant="body2">No relationships match these filters.</Typography>
              </Box>
            ) : (
              <ForceGraph
                nodes={gnodes}
                edges={gedges}
                onOpen={(id) => navigate(`/people/${id}`)}
                highlight={highlight}
                resetSignal={resetSignal}
                layout={graphMode}
              />
            )}
            <ToggleButtonGroup
              size="small"
              exclusive
              value={graphMode}
              onChange={(_, v) => v && setGraphMode(v)}
              sx={{ position: 'absolute', top: 10, left: 10, bgcolor: 'background.paper', boxShadow: 3 }}
            >
              <ToggleButton value="force">Graph</ToggleButton>
              <ToggleButton value="tree">Tree</ToggleButton>
            </ToggleButtonGroup>
            <Tooltip title="Recenter graph">
              <IconButton
                aria-label="Recenter graph"
                onClick={() => setResetSignal((n) => n + 1)}
                sx={{
                  position: 'absolute',
                  top: 10,
                  right: 10,
                  bgcolor: 'background.paper',
                  boxShadow: 3,
                  '&:hover': { bgcolor: 'background.paper' }
                }}
              >
                <CenterFocusStrongIcon />
              </IconButton>
            </Tooltip>
            <Box
              sx={{
                position: 'absolute',
                left: 10,
                bottom: 10,
                px: 1.25,
                py: 1,
                borderRadius: 2,
                bgcolor: 'background.paper',
                boxShadow: 3,
                display: 'flex',
                flexWrap: 'wrap',
                gap: 1,
                maxWidth: 360
              }}
            >
              {LEGEND.map((l) => (
                <Stack key={l.t} direction="row" spacing={0.5} alignItems="center">
                  <Box sx={{ width: 12, height: 3, borderRadius: 1, bgcolor: l.c }} />
                  <Typography variant="caption" color="text.secondary">
                    {l.t}
                  </Typography>
                </Stack>
              ))}
            </Box>
          </Box>

          {/* Relationship list: edit / delete / bulk delete */}
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 3, mb: 1, flexWrap: 'wrap' }}>
            <Typography variant="subtitle2" sx={{ flex: 1 }}>
              Relationships ({filtering ? `${view.edges.length} of ${graph.edges.length}` : graph.edges.length})
            </Typography>
            <Button
              size="small"
              color="error"
              startIcon={<DeleteIcon />}
              disabled={selEdges.size === 0}
              onClick={() => deleteMany([...selEdges])}
            >
              Delete selected ({selEdges.size})
            </Button>
            <Button size="small" color="error" variant="outlined" onClick={clearAll}>
              Clear all
            </Button>
          </Stack>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ pl: 0.5 }}>
            <Checkbox
              size="small"
              checked={allSelected}
              indeterminate={selEdges.size > 0 && !allSelected}
              onChange={toggleSelectAll}
              inputProps={{ 'aria-label': 'Select all shown relationships' }}
            />
            <Typography variant="caption" color="text.secondary">
              Select all shown
            </Typography>
          </Stack>
          <Stack divider={<Divider flexItem />}>
            {view.edges.map((e) => (
              <Stack
                key={e.id}
                direction="row"
                alignItems="center"
                spacing={1}
                sx={{
                  py: 0.5,
                  bgcolor: (t) => (selEdges.has(e.id) ? t.palette.action.selected : 'transparent')
                }}
              >
                <Checkbox
                  size="small"
                  checked={selEdges.has(e.id)}
                  onChange={() => toggleEdgeSel(e.id)}
                  inputProps={{ 'aria-label': `Select ${nameOf(e.person_a)} – ${nameOf(e.person_b)}` }}
                />
                <Typography sx={{ fontWeight: 500 }}>{nameOf(e.person_a)}</Typography>
                <Chip
                  size="small"
                  label={`${edgeKind(e) === 'parent' ? 'parent of' : edgeKind(e) === 'child' ? 'child of' : edgeLabel(e)}${e.directed ? ' →' : ''}`}
                  sx={{ bgcolor: edgeColor(e), color: '#111' }}
                />
                <Typography sx={{ fontWeight: 500 }}>{nameOf(e.person_b)}</Typography>
                <Box sx={{ flex: 1 }} />
                <Tooltip title="Edit this relation">
                  <IconButton size="small" aria-label="Edit relation" onClick={() => openEdit(e)}>
                    <EditIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Delete this relation">
                  <IconButton size="small" aria-label="Delete relation" onClick={() => removeRelation(e.id)}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            ))}
          </Stack>
        </>
      )}

      {/* Add / edit relation dialog */}
      <Dialog open={dialog} onClose={() => !saving && setDialog(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingId !== null ? 'Edit relation' : 'Add relation'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Box>
              <Typography variant="caption" color="text.secondary">
                Person
              </Typography>
              {renderPeopleGrid(draft.a, (a) => setDraft((d) => ({ ...d, a })), null)}
            </Box>

            <Box>
              <Typography variant="caption" color="text.secondary">
                Relationship
              </Typography>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(4, 1fr)' },
                  gap: 1,
                  mt: 0.5
                }}
              >
                {PRESETS.map((p) => {
                  const on = draft.kind === p.kind
                  return (
                    <Button
                      key={p.kind}
                      onClick={() => setDraft((d) => ({ ...d, kind: p.kind }))}
                      variant={on ? 'contained' : 'outlined'}
                      size="small"
                      aria-pressed={on}
                      startIcon={
                        <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: p.color }} />
                      }
                      sx={{
                        justifyContent: 'flex-start',
                        textTransform: 'none',
                        ...(on && { bgcolor: p.color, color: '#111', '&:hover': { bgcolor: p.color } })
                      }}
                    >
                      {p.title}
                    </Button>
                  )
                })}
              </Box>
            </Box>

            {draft.kind === 'custom' && (
              <Stack direction="row" spacing={1} alignItems="center">
                <TextField
                  label="Label"
                  placeholder="cousin, mentor…"
                  value={draft.label}
                  onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                  inputProps={{ maxLength: 60 }}
                  fullWidth
                />
                <Tooltip title="Directed (Person → Related to)">
                  <ToggleButton
                    size="small"
                    value="dir"
                    selected={draft.directed}
                    aria-label="Directed relationship"
                    onChange={() => setDraft((d) => ({ ...d, directed: !d.directed }))}
                  >
                    →
                  </ToggleButton>
                </Tooltip>
              </Stack>
            )}

            <Box>
              <Typography variant="caption" color="text.secondary">
                {preset.kind === 'parent'
                  ? 'Is a parent of'
                  : preset.kind === 'child'
                    ? 'Is a child of'
                    : 'Related to'}
              </Typography>
              {renderPeopleGrid(draft.b, (b) => setDraft((d) => ({ ...d, b })), draft.a)}
            </Box>

            {saveError && (
              <Alert
                severity={conflict ? 'warning' : 'error'}
                action={
                  conflict && editingId === null ? (
                    <Button color="inherit" size="small" onClick={() => save(true)} disabled={saving}>
                      Replace
                    </Button>
                  ) : undefined
                }
              >
                {saveError}
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialog(false)} disabled={saving}>
            Cancel
          </Button>
          <Tooltip title={draftProblem ?? ''}>
            <span>
              <Button variant="contained" onClick={() => save(false)} disabled={!!draftProblem || saving}>
                {saving ? 'Saving…' : editingId !== null ? 'Save' : 'Add'}
              </Button>
            </span>
          </Tooltip>
        </DialogActions>
      </Dialog>

      {/* Auto-connect: preview, then the user picks which pairs to save */}
      <Dialog open={autoOpen} onClose={() => !autoBusy && closeAuto()} maxWidth="sm" fullWidth>
        <DialogTitle>Auto-connect people</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Finds people who appear together in your photos. Photos can&apos;t tell the
            relationship type, so confirmed pairs are saved as “appears with”; edit them
            afterwards. Only the pairs you tick are saved.
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField
              select
              size="small"
              label="Minimum shared photos"
              value={minShared}
              onChange={(e) => {
                setMinShared(e.target.value)
                setProposals(null)
              }}
              sx={{ minWidth: 200 }}
            >
              {['1', '2', '3', '5'].map((v) => (
                <MenuItem key={v} value={v}>
                  {v}
                </MenuItem>
              ))}
            </TextField>
            <Button onClick={previewAuto} disabled={autoBusy}>
              {proposals ? 'Refresh' : 'Find pairs'}
            </Button>
          </Stack>
          {proposals && (
            <Box sx={{ mt: 2 }}>
              {proposals.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No unconnected pairs at this threshold.
                </Typography>
              ) : (
                <>
                  <Stack direction="row" alignItems="center">
                    <Checkbox
                      size="small"
                      checked={chosen.size === proposals.length}
                      indeterminate={chosen.size > 0 && chosen.size < proposals.length}
                      onChange={() =>
                        setChosen(
                          chosen.size === proposals.length
                            ? new Set()
                            : new Set(proposals.map(pairKey))
                        )
                      }
                      inputProps={{ 'aria-label': 'Select all pairs' }}
                    />
                    <Typography variant="caption" color="text.secondary">
                      {chosen.size} of {proposals.length} selected
                    </Typography>
                  </Stack>
                  <Stack sx={{ maxHeight: 280, overflow: 'auto' }}>
                    {proposals.map((p) => {
                      const k = pairKey(p)
                      return (
                        <Stack key={k} direction="row" alignItems="center" spacing={1}>
                          <Checkbox
                            size="small"
                            checked={chosen.has(k)}
                            onChange={() =>
                              setChosen((prev) => {
                                const n = new Set(prev)
                                if (n.has(k)) n.delete(k)
                                else n.add(k)
                                return n
                              })
                            }
                            inputProps={{ 'aria-label': `Connect ${p.a_name ?? p.a} and ${p.b_name ?? p.b}` }}
                          />
                          <Avatar src={personFaceUrl(p.a)} sx={{ width: 24, height: 24 }} />
                          <Typography variant="body2">{p.a_name ?? `Unnamed #${p.a}`}</Typography>
                          <Typography variant="body2" color="text.secondary">
                            +
                          </Typography>
                          <Avatar src={personFaceUrl(p.b)} sx={{ width: 24, height: 24 }} />
                          <Typography variant="body2">{p.b_name ?? `Unnamed #${p.b}`}</Typography>
                          <Box sx={{ flex: 1 }} />
                          <Typography variant="caption" color="text.secondary">
                            {p.shared} photos
                          </Typography>
                        </Stack>
                      )
                    })}
                  </Stack>
                </>
              )}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeAuto} disabled={autoBusy}>
            Cancel
          </Button>
          <Button variant="contained" onClick={confirmAuto} disabled={autoBusy || chosen.size === 0}>
            {autoBusy ? 'Working…' : `Connect ${chosen.size || ''}`.trim()}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
