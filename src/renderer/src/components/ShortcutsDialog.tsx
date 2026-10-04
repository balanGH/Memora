import { useEffect, useState } from 'react'
import {
  Box,
  Dialog,
  DialogContent,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableRow,
  Typography
} from '@mui/material'

const SECTIONS: { title: string; keys: [string, string][] }[] = [
  {
    title: 'Anywhere',
    keys: [
      ['Ctrl+K  or  /', 'Focus search'],
      ['?', 'Show this list']
    ]
  },
  {
    title: 'Photo grid',
    keys: [
      ['Arrow keys, Home, End', 'Move between photos'],
      ['Enter', 'Open photo'],
      ['Space  /  Shift+Space', 'Select  /  select range'],
      ['Ctrl+A', 'Select all loaded photos'],
      ['F', 'Favorite'],
      ['E', 'Archive'],
      ['Delete', 'Move to trash'],
      ['Esc', 'Clear selection']
    ]
  },
  {
    title: 'Photo viewer',
    keys: [
      ['Left / Right', 'Previous / next'],
      ['F', 'Favorite'],
      ['E', 'Archive'],
      ['Delete', 'Move to trash'],
      ['S', 'Similar photos'],
      ['I', 'Info panel'],
      ['+  -  0', 'Zoom in / out / reset'],
      ['Esc', 'Close']
    ]
  }
]

/** "?" opens a list of keyboard shortcuts. */
export default function ShortcutsDialog(): JSX.Element {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if (e.key === '?' && !typing) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <Dialog open={open} onClose={() => setOpen(false)} maxWidth="xs" fullWidth>
      <DialogTitle>Keyboard shortcuts</DialogTitle>
      <DialogContent>
        {SECTIONS.map((s) => (
          <Box key={s.title} sx={{ mb: 2 }}>
            <Typography variant="subtitle2" color="text.secondary" component="h3">
              {s.title}
            </Typography>
            <Table size="small">
              <TableBody>
                {s.keys.map(([k, what]) => (
                  <TableRow key={k + what}>
                    <TableCell sx={{ pl: 0, width: '45%' }}>
                      <Typography component="kbd" sx={{ fontFamily: 'monospace', fontSize: 13 }}>
                        {k}
                      </Typography>
                    </TableCell>
                    <TableCell sx={{ pr: 0 }}>{what}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        ))}
      </DialogContent>
    </Dialog>
  )
}
