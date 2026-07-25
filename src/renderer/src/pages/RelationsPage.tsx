import { useCallback, useEffect, useState } from 'react'
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
  Snackbar,
  Alert,
  Checkbox
} from '@mui/material'
import HubIcon from '@mui/icons-material/Hub'
import AddIcon from '@mui/icons-material/Add'
import DeleteIcon from '@mui/icons-material/Delete'
import EditIcon from '@mui/icons-material/Edit'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import CenterFocusStrongIcon from '@mui/icons-material/CenterFocusStrong'
import ForceGraph from '../components/ForceGraph'
import FamilyRestroomIcon from '@mui/icons-material/FamilyRestroom'
import { api, personFaceUrl } from '../api/client'
import type {
  FamilySuggestion,
  Person,
  RelationGraph,
  RelationSuggestion
} from '../api/types'

// Preset relationship types → label, direction, and edge color.
interface Preset {
  key: string
  title: string
  label: string
  directed: boolean
  color: string
}
const PRESETS: Preset[] = [
  { key: 'parent', title: 'Parent of', label: 'parent', directed: true, color: '#e57373' },
  { key: 'child', title: 'Child of', label: 'child', directed: true, color: '#e57373' },
  { key: 'spouse', title: 'Spouse', label: 'spouse', directed: false, color: '#ba68c8' },
  { key: 'sibling', title: 'Sibling', label: 'sibling', directed: false, color: '#4fc3f7' },
  { key: 'friend', title: 'Friend', label: 'friend', directed: false, color: '#81c784' },
  { key: 'colleague', title: 'Colleague', label: 'colleague', directed: false, color: '#ffb74d' },
  { key: 'custom', title: 'Custom', label: '', directed: false, color: '#8ab4f8' }
]

const COLOR_BY_WORD: Record<string, string> = {
  parent: '#e57373', child: '#e57373', mother: '#e57373', father: '#e57373',
  mom: '#e57373', dad: '#e57373', son: '#e57373', daughter: '#e57373',
  spouse: '#ba68c8', wife: '#ba68c8', husband: '#ba68c8', partner: '#ba68c8',
  sibling: '#4fc3f7', brother: '#4fc3f7', sister: '#4fc3f7',
  friend: '#81c784', colleague: '#ffb74d', cousin: '#4dd0e1'
}
function edgeColor(label: string): string {
  const w = label.trim().toLowerCase()
  return COLOR_BY_WORD[w] ?? '#8ab4f8'
}

const LEGEND = [
  { c: '#e57373', t: 'Parent/child' },
  { c: '#ba68c8', t: 'Spouse' },
  { c: '#4fc3f7', t: 'Sibling' },
  { c: '#81c784', t: 'Friend' },
  { c: '#ffb74d', t: 'Colleague' },
  { c: '#8ab4f8', t: 'Other' }
]

export default function RelationsPage(): JSX.Element {
  const navigate = useNavigate()
  const [graph, setGraph] = useState<RelationGraph>({ nodes: [], edges: [] })
  const [people, setPeople] = useState<Person[]>([])
  const [suggestions, setSuggestions] = useState<RelationSuggestion[]>([])
  const [family, setFamily] = useState<FamilySuggestion[]>([])
  const [loaded, setLoaded] = useState(false)

  const [dialog, setDialog] = useState(false)
  const [aId, setAId] = useState('')
  const [bId, setBId] = useState('')
  const [preset, setPreset] = useState('friend')
  const [custom, setCustom] = useState('')
  const [customDirected, setCustomDirected] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [resetSignal, setResetSignal] = useState(0)
  const [graphMode, setGraphMode] = useState<'force' | 'tree'>('force')
  const [selEdges, setSelEdges] = useState<Set<number>>(new Set())
  const [autoOpen, setAutoOpen] = useState(false)
  const [minShared, setMinShared] = useState('2')
  const [autoBusy, setAutoBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const load = useCallback(() => {
    api.relations().then(setGraph)
    api.relationSuggestions().then((r) => setSuggestions(r.suggestions))
    api.familySuggestions().then((r) => setFamily(r.suggestions))
  }, [])
  useEffect(() => {
    Promise.all([
      api.relations().then(setGraph),
      api.relationSuggestions().then((r) => setSuggestions(r.suggestions)),
      api.familySuggestions().then((r) => setFamily(r.suggestions)),
      api.people(true).then((r) => setPeople(r.people))
    ]).finally(() => setLoaded(true))
  }, [])

  const acceptParent = async (parent: number, child: number): Promise<void> => {
    await api.addRelation(parent, child, 'parent', true)
    load()
  }

  const nameOf = useCallback(
    (id: number): string => {
      const n = graph.nodes.find((x) => x.id === id) ?? people.find((x) => x.id === id)
      return n?.name ?? `Unnamed #${id}`
    },
    [graph.nodes, people]
  )

  const openDialog = (a = '', b = ''): void => {
    setEditingId(null)
    setAId(a)
    setBId(b)
    setPreset('friend')
    setCustom('')
    setCustomDirected(false)
    setDialog(true)
  }

  const openEdit = (edge: RelationGraph['edges'][number]): void => {
    const lbl = (edge.label || '').toLowerCase()
    const match = PRESETS.find(
      (p) => p.key !== 'custom' && p.label === lbl && p.directed === !!edge.directed
    )
    setEditingId(edge.id)
    setAId(String(edge.person_a))
    setBId(String(edge.person_b))
    if (match) {
      setPreset(match.key)
      setCustom('')
      setCustomDirected(false)
    } else {
      setPreset('custom')
      setCustom(edge.label)
      setCustomDirected(!!edge.directed)
    }
    setDialog(true)
  }

  const addRelation = async (): Promise<void> => {
    const a = Number(aId)
    const b = Number(bId)
    if (!a || !b || a === b) return
    const p = PRESETS.find((x) => x.key === preset)!
    const label = p.key === 'custom' ? custom.trim() : p.label
    const directed = p.key === 'custom' ? customDirected : p.directed
    setSaving(true)
    try {
      // When editing, remove the original first so changing the people pair
      // doesn't leave a stale relation behind.
      if (editingId !== null) await api.deleteRelation(editingId)
      await api.addRelation(a, b, label, directed)
      setDialog(false)
      setEditingId(null)
      load()
    } finally {
      setSaving(false)
    }
  }

  const removeRelation = async (id: number): Promise<void> => {
    await api.deleteRelation(id)
    setSelEdges((prev) => {
      const n = new Set(prev)
      n.delete(id)
      return n
    })
    load()
  }

  const toggleEdgeSel = (id: number): void => {
    setSelEdges((prev) => {
      const n = new Set(prev)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }
  const allSelected = graph.edges.length > 0 && selEdges.size === graph.edges.length
  const toggleSelectAll = (): void => {
    setSelEdges(allSelected ? new Set() : new Set(graph.edges.map((e) => e.id)))
  }

  const deleteSelected = async (): Promise<void> => {
    if (selEdges.size === 0) return
    await Promise.all([...selEdges].map((id) => api.deleteRelation(id)))
    setSelEdges(new Set())
    load()
  }

  const clearAll = async (): Promise<void> => {
    if (graph.edges.length === 0) return
    if (!window.confirm(`Delete all ${graph.edges.length} relationships?`)) return
    await Promise.all(graph.edges.map((e) => api.deleteRelation(e.id)))
    setSelEdges(new Set())
    load()
  }


  const runAutoConnect = async (): Promise<void> => {
    setAutoBusy(true)
    try {
      const r = await api.autoConnectRelations(Math.max(1, Number(minShared) || 2))
      setAutoOpen(false)
      load()
      setToast(
        r.created > 0
          ? `Auto-connected ${r.created} relationship${r.created === 1 ? '' : 's'} — rename them below`
          : 'No new co-occurring pairs to connect'
      )
    } finally {
      setAutoBusy(false)
    }
  }

  // Grid of selectable people (avatar + name) used in the add/edit dialog.
  const renderPeopleGrid = (
    value: string,
    onChange: (v: string) => void,
    exclude?: string
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
        .filter((p) => String(p.id) !== exclude)
        .map((p) => {
          const on = value === String(p.id)
          return (
            <Box
              key={p.id}
              onClick={() => onChange(String(p.id))}
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

  const gnodes = graph.nodes.map((n) => ({
    id: n.id,
    name: n.name,
    photo_count: n.photo_count
  }))
  const gedges = graph.edges.map((e) => ({
    id: e.id,
    a: e.person_a,
    b: e.person_b,
    label: e.label,
    directed: !!e.directed
  }))

  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <HubIcon color="primary" />
        <Typography variant="h5" sx={{ fontWeight: 600, flex: 1 }}>
          Relations
        </Typography>
        <Tooltip title="Create links automatically from people photographed together">
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
        Graph or Tree view · drag faces · scroll to zoom · hover to focus · click a face to
        open that person. Edit or delete relationships in the list below.
      </Typography>

      {/* Family (parent/child) suggestions from estimated ages */}
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
                onClick={() => acceptParent(f.parent, f.child)}
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
            Guessed from face age estimates — confirm before trusting. Click to add.
          </Typography>
        </Box>
      )}

      {/* Suggestions */}
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
                onClick={() => openDialog(String(s.a), String(s.b))}
                label={`${s.a_name ?? 'Unnamed'} + ${s.b_name ?? 'Unnamed'} · ${s.shared}`}
                variant="outlined"
                icon={<AddIcon />}
              />
            ))}
          </Stack>
        </Box>
      )}

      {loaded && graph.edges.length === 0 ? (
        <Box
          sx={{
            height: 300,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'text.secondary',
            gap: 1
          }}
        >
          <Typography variant="h6">No relations yet</Typography>
          <Typography variant="body2">
            {people.length < 2
              ? 'You need at least two people. Let AI processing finish first.'
              : 'Add a relation, or pick a suggestion above.'}
          </Typography>
        </Box>
      ) : (
        <>
          <Box
            sx={{
              border: (t) => `1px solid ${t.palette.divider}`,
              borderRadius: 3,
              overflow: 'hidden',
              position: 'relative',
              bgcolor: (t) => (t.palette.mode === 'dark' ? '#15171c' : '#fafafa')
            }}
          >
            <ForceGraph
              nodes={gnodes}
              edges={gedges}
              onOpen={(id) => navigate(`/people/${id}`)}
              edgeColor={edgeColor}
              resetSignal={resetSignal}
              layout={graphMode}
            />
            {/* Layout toggle */}
            <ToggleButtonGroup
              size="small"
              exclusive
              value={graphMode}
              onChange={(_, v) => v && setGraphMode(v)}
              sx={{
                position: 'absolute',
                top: 10,
                left: 10,
                bgcolor: 'background.paper',
                boxShadow: 3
              }}
            >
              <ToggleButton value="force">Graph</ToggleButton>
              <ToggleButton value="tree">Tree</ToggleButton>
            </ToggleButtonGroup>
            {/* Recenter — always visible; brings faces back if you pan/zoom away */}
            <Tooltip title="Recenter graph">
              <IconButton
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
            {/* legend */}
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
                maxWidth: 320
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

          {/* Edit list with selectable / bulk deletion */}
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 3, mb: 1 }}>
            <Typography variant="subtitle2" sx={{ flex: 1 }}>
              Relationships ({graph.edges.length})
            </Typography>
            <Button
              size="small"
              color="error"
              startIcon={<DeleteIcon />}
              disabled={selEdges.size === 0}
              onClick={deleteSelected}
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
            />
            <Typography variant="caption" color="text.secondary">
              Select all
            </Typography>
          </Stack>
          <Stack divider={<Divider flexItem />}>
            {graph.edges.map((e) => (
              <Stack
                key={e.id}
                direction="row"
                alignItems="center"
                spacing={1}
                sx={{
                  py: 0.5,
                  bgcolor: (t) =>
                    selEdges.has(e.id) ? t.palette.action.selected : 'transparent'
                }}
              >
                <Checkbox
                  size="small"
                  checked={selEdges.has(e.id)}
                  onChange={() => toggleEdgeSel(e.id)}
                />
                <Typography sx={{ fontWeight: 500 }}>{nameOf(e.person_a)}</Typography>
                <Chip
                  size="small"
                  label={`${e.label || 'related'}${e.directed ? ' →' : ''}`}
                  sx={{ bgcolor: edgeColor(e.label), color: '#111' }}
                />
                <Typography sx={{ fontWeight: 500 }}>{nameOf(e.person_b)}</Typography>
                <Box sx={{ flex: 1 }} />
                <Tooltip title="Edit this relation">
                  <IconButton size="small" onClick={() => openEdit(e)}>
                    <EditIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Delete this relation">
                  <IconButton size="small" onClick={() => removeRelation(e.id)}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            ))}
          </Stack>
        </>
      )}

      {/* Add / edit relation dialog */}
      <Dialog open={dialog} onClose={() => setDialog(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingId !== null ? 'Edit relation' : 'Add relation'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Box>
              <Typography variant="caption" color="text.secondary">
                Person
              </Typography>
              {renderPeopleGrid(aId, setAId)}
            </Box>

            <Box>
              <Typography variant="caption" color="text.secondary">
                Relationship
              </Typography>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: 1,
                  mt: 0.5
                }}
              >
                {PRESETS.map((p) => {
                  const on = preset === p.key
                  return (
                    <Button
                      key={p.key}
                      onClick={() => setPreset(p.key)}
                      variant={on ? 'contained' : 'outlined'}
                      size="small"
                      startIcon={
                        <Box
                          sx={{
                            width: 10,
                            height: 10,
                            borderRadius: '50%',
                            bgcolor: p.color
                          }}
                        />
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

            {preset === 'custom' && (
              <Stack direction="row" spacing={1} alignItems="center">
                <TextField
                  label="Label"
                  placeholder="cousin, mentor…"
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  fullWidth
                />
                <Tooltip title="Directed (A → B)">
                  <ToggleButton
                    size="small"
                    value="dir"
                    selected={customDirected}
                    onChange={() => setCustomDirected((d) => !d)}
                  >
                    →
                  </ToggleButton>
                </Tooltip>
              </Stack>
            )}

            <Box>
              <Typography variant="caption" color="text.secondary">
                {PRESETS.find((p) => p.key === preset)?.directed
                  ? 'Related to (target)'
                  : 'Related to'}
              </Typography>
              {renderPeopleGrid(bId, setBId, aId)}
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialog(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={addRelation}
            disabled={!aId || !bId || aId === bId || saving}
          >
            {saving ? 'Saving…' : editingId !== null ? 'Save' : 'Add'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Auto-connect dialog */}
      <Dialog open={autoOpen} onClose={() => setAutoOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Auto-connect people</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Links people who appear together in your photos. Photos can't tell the
            relationship type, so new links are labeled “appears with” — rename the
            important ones afterwards. Existing relations are kept.
          </Typography>
          <TextField
            select
            label="Minimum shared photos"
            value={minShared}
            onChange={(e) => setMinShared(e.target.value)}
            fullWidth
            helperText="Higher = fewer, stronger links"
          >
            {['1', '2', '3', '5'].map((v) => (
              <MenuItem key={v} value={v}>
                {v}
              </MenuItem>
            ))}
          </TextField>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAutoOpen(false)} disabled={autoBusy}>
            Cancel
          </Button>
          <Button variant="contained" onClick={runAutoConnect} disabled={autoBusy}>
            {autoBusy ? 'Connecting…' : 'Connect'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!toast}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {toast ? (
          <Alert severity="success" onClose={() => setToast(null)}>
            {toast}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  )
}
