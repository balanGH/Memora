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
  Alert
} from '@mui/material'
import HubIcon from '@mui/icons-material/Hub'
import AddIcon from '@mui/icons-material/Add'
import DeleteIcon from '@mui/icons-material/Delete'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import CenterFocusStrongIcon from '@mui/icons-material/CenterFocusStrong'
import ForceGraph from '../components/ForceGraph'
import { api, personFaceUrl } from '../api/client'
import type { Person, RelationGraph, RelationSuggestion } from '../api/types'

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
  const [loaded, setLoaded] = useState(false)

  const [dialog, setDialog] = useState(false)
  const [aId, setAId] = useState('')
  const [bId, setBId] = useState('')
  const [preset, setPreset] = useState('friend')
  const [custom, setCustom] = useState('')
  const [customDirected, setCustomDirected] = useState(false)
  const [saving, setSaving] = useState(false)
  const [resetSignal, setResetSignal] = useState(0)
  const [autoOpen, setAutoOpen] = useState(false)
  const [minShared, setMinShared] = useState('2')
  const [autoBusy, setAutoBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const load = useCallback(() => {
    api.relations().then(setGraph)
    api.relationSuggestions().then((r) => setSuggestions(r.suggestions))
  }, [])
  useEffect(() => {
    Promise.all([
      api.relations().then(setGraph),
      api.relationSuggestions().then((r) => setSuggestions(r.suggestions)),
      api.people(true).then((r) => setPeople(r.people))
    ]).finally(() => setLoaded(true))
  }, [])

  const nameOf = useCallback(
    (id: number): string => {
      const n = graph.nodes.find((x) => x.id === id) ?? people.find((x) => x.id === id)
      return n?.name ?? `Unnamed #${id}`
    },
    [graph.nodes, people]
  )

  const openDialog = (a = '', b = ''): void => {
    setAId(a)
    setBId(b)
    setPreset('friend')
    setCustom('')
    setCustomDirected(false)
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
      await api.addRelation(a, b, label, directed)
      setDialog(false)
      load()
    } finally {
      setSaving(false)
    }
  }

  const removeRelation = async (id: number): Promise<void> => {
    await api.deleteRelation(id)
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
        Drag faces to rearrange · scroll to zoom · drag the background to pan · hover to
        focus · click a face to open that person.
      </Typography>

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
            />
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

          {/* Edit list */}
          <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
            Relationships
          </Typography>
          <Stack spacing={1} divider={<Divider flexItem />}>
            {graph.edges.map((e) => (
              <Stack key={e.id} direction="row" alignItems="center" spacing={1}>
                <Typography sx={{ fontWeight: 500 }}>{nameOf(e.person_a)}</Typography>
                <Chip
                  size="small"
                  label={`${e.label || 'related'}${e.directed ? ' →' : ''}`}
                  sx={{ bgcolor: edgeColor(e.label), color: '#111' }}
                />
                <Typography sx={{ fontWeight: 500 }}>{nameOf(e.person_b)}</Typography>
                <Box sx={{ flex: 1 }} />
                <IconButton size="small" onClick={() => removeRelation(e.id)}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Stack>
            ))}
          </Stack>
        </>
      )}

      {/* Add-relation dialog */}
      <Dialog open={dialog} onClose={() => setDialog(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Add relation</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              select
              label="Person"
              value={aId}
              onChange={(e) => setAId(e.target.value)}
              fullWidth
            >
              {people.map((p) => (
                <MenuItem key={p.id} value={String(p.id)}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Avatar src={personFaceUrl(p.id)} sx={{ width: 26, height: 26 }} />
                    <span>
                      {p.name ?? `Unnamed #${p.id}`} ({p.photo_count})
                    </span>
                  </Stack>
                </MenuItem>
              ))}
            </TextField>

            <Box>
              <Typography variant="caption" color="text.secondary">
                Relationship
              </Typography>
              <ToggleButtonGroup
                size="small"
                exclusive
                value={preset}
                onChange={(_, v) => v && setPreset(v)}
                sx={{ flexWrap: 'wrap', mt: 0.5 }}
              >
                {PRESETS.map((p) => (
                  <ToggleButton key={p.key} value={p.key}>
                    {p.title}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
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

            <TextField
              select
              label={
                PRESETS.find((p) => p.key === preset)?.directed ? 'Related to (target)' : 'Related to'
              }
              value={bId}
              onChange={(e) => setBId(e.target.value)}
              fullWidth
            >
              {people
                .filter((p) => String(p.id) !== aId)
                .map((p) => (
                  <MenuItem key={p.id} value={String(p.id)}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Avatar src={personFaceUrl(p.id)} sx={{ width: 26, height: 26 }} />
                      <span>
                        {p.name ?? `Unnamed #${p.id}`} ({p.photo_count})
                      </span>
                    </Stack>
                  </MenuItem>
                ))}
            </TextField>
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
            {saving ? 'Adding…' : 'Add'}
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
