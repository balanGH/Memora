import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Autocomplete, Box, InputBase, Typography, alpha } from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import PersonIcon from '@mui/icons-material/Person'
import LocalOfferIcon from '@mui/icons-material/LocalOffer'
import { api } from '../api/client'

type Option =
  | { type: 'query'; label: string }
  | { type: 'person'; label: string; id: number; count: number }
  | { type: 'tag'; label: string; count: number }

const GROUP: Record<Option['type'], string> = {
  query: 'Search',
  person: 'People',
  tag: 'Things & scenes'
}

/**
 * Top-bar search with live suggestions (people, tags). Ctrl+K or "/" focuses
 * it from anywhere in the app.
 */
export default function SearchBox({ dark }: { dark: boolean }): JSX.Element {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [input, setInput] = useState(params.get('q') ?? '')
  const [options, setOptions] = useState<Option[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const urlQuery = params.get('q') ?? ''

  // Keep the box in sync when the query changes elsewhere (chips, back button).
  useEffect(() => {
    setInput(urlQuery)
  }, [urlQuery])

  // Global focus shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Debounced suggestions.
  useEffect(() => {
    const q = input.trim()
    if (!q) {
      setOptions([])
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      api
        .suggest(q)
        .then((r) => {
          if (cancelled) return
          setOptions([
            { type: 'query', label: q },
            ...r.people.map((p) => ({ type: 'person' as const, label: p.name, id: p.id, count: p.count })),
            ...r.tags.map((t) => ({ type: 'tag' as const, label: t.label, count: t.count }))
          ])
        })
        .catch(() => {})
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [input])

  const go = (opt: Option | string | null): void => {
    if (!opt) return
    if (typeof opt === 'string') {
      if (opt.trim()) navigate(`/search?q=${encodeURIComponent(opt.trim())}`)
    } else if (opt.type === 'person') {
      navigate(`/people/${opt.id}`)
      setInput('')
    } else {
      setInput(opt.label)
      navigate(`/search?q=${encodeURIComponent(opt.label)}`)
    }
    inputRef.current?.blur()
  }

  return (
    <Autocomplete<Option, false, false, true>
      freeSolo
      options={options}
      filterOptions={(x) => x}
      groupBy={(o) => GROUP[o.type]}
      getOptionLabel={(o) => (typeof o === 'string' ? o : o.label)}
      inputValue={input}
      onInputChange={(_, v) => setInput(v)}
      onChange={(_, v) => go(v)}
      value={null}
      blurOnSelect
      sx={{ width: 'min(560px, 45vw)' }}
      renderOption={(props, o) => (
        <Box component="li" {...props} key={`${o.type}-${o.label}`} sx={{ gap: 1.25 }}>
          {o.type === 'person' ? (
            <PersonIcon fontSize="small" color="action" />
          ) : o.type === 'tag' ? (
            <LocalOfferIcon fontSize="small" color="action" />
          ) : (
            <SearchIcon fontSize="small" color="action" />
          )}
          <Typography sx={{ flex: 1 }} noWrap>
            {o.type === 'query' ? `Search for “${o.label}”` : o.label}
          </Typography>
          {o.type !== 'query' && (
            <Typography variant="caption" color="text.secondary">
              {o.count}
            </Typography>
          )}
        </Box>
      )}
      renderInput={(p) => (
        <Box
          ref={p.InputProps.ref}
          sx={{
            display: 'flex',
            alignItems: 'center',
            bgcolor: (t) => alpha(t.palette.text.primary, dark ? 0.08 : 0.05),
            borderRadius: 999,
            px: 2,
            py: 0.5,
            '&:focus-within': { boxShadow: (t) => `0 0 0 2px ${t.palette.primary.main}` }
          }}
        >
          <SearchIcon fontSize="small" sx={{ mr: 1, opacity: 0.6 }} />
          <InputBase
            inputProps={{ ...p.inputProps, 'aria-label': 'Search photos' }}
            inputRef={inputRef}
            fullWidth
            placeholder='Search people, things, places — try "dog" (Ctrl+K)'
          />
        </Box>
      )}
    />
  )
}
