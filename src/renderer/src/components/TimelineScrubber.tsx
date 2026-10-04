import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Box, ButtonBase, Typography } from '@mui/material'
import type { TimelineMonth } from '../api/types'

interface Props {
  months: TimelineMonth[]
  /** Jump to the item at this offset in the current sort order. */
  onJump: (offset: number) => void
}

function monthLabel(month: string | null): string {
  if (!month) return 'Unknown date'
  const [y, m] = month.split('-').map(Number)
  if (!y || !m) return month
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

const MIN_LABEL_GAP = 18 // px between year labels before we drop one

/**
 * Google-Photos-style date rail. Years are placed proportionally to how many
 * photos come before them; hovering shows the month under the cursor and a
 * click jumps there. Year labels are buttons, so it works from the keyboard.
 */
export default function TimelineScrubber({ months, onJump }: Props): JSX.Element | null {
  const railRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  const [hover, setHover] = useState<{ y: number; month: TimelineMonth } | null>(null)
  const total = months.reduce((n, m) => n + m.count, 0)

  useLayoutEffect(() => {
    const el = railRef.current
    if (!el) return
    const ro = new ResizeObserver((e) => setHeight(e[0].contentRect.height))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // First month of each year, with its vertical position.
  const years = useMemo(() => {
    const out: { year: string; month: TimelineMonth; top: number }[] = []
    let lastYear: string | null = null
    let lastTop = -Infinity
    for (const m of months) {
      const year = m.month ? m.month.slice(0, 4) : '?'
      if (year === lastYear) continue
      lastYear = year
      const top = total ? (m.offset / total) * height : 0
      if (top - lastTop < MIN_LABEL_GAP) continue
      lastTop = top
      out.push({ year, month: m, top })
    }
    return out
  }, [months, total, height])

  if (months.length < 2 || !total) return null

  const monthAt = (y: number): TimelineMonth => {
    const target = (Math.max(0, Math.min(y, height)) / height) * total
    let found = months[0]
    for (const m of months) {
      if (m.offset <= target) found = m
      else break
    }
    return found
  }

  return (
    <Box
      component="nav"
      aria-label="Jump to date"
      ref={railRef}
      onMouseMove={(e) => {
        const y = e.clientY - e.currentTarget.getBoundingClientRect().top
        setHover({ y, month: monthAt(y) })
      }}
      onMouseLeave={() => setHover(null)}
      onClick={(e) => {
        const y = e.clientY - e.currentTarget.getBoundingClientRect().top
        onJump(monthAt(y).offset)
      }}
      sx={{
        position: 'relative',
        width: 56,
        flexShrink: 0,
        my: 1.5,
        cursor: 'pointer',
        borderLeft: (t) => `1px solid ${t.palette.divider}`
      }}
    >
      {years.map((y) => (
        <ButtonBase
          key={y.year}
          onClick={(e) => {
            e.stopPropagation()
            onJump(y.month.offset)
          }}
          aria-label={`Jump to ${y.year}`}
          sx={{
            position: 'absolute',
            top: y.top,
            right: 6,
            px: 0.5,
            borderRadius: 1,
            transform: 'translateY(-2px)',
            '&:focus-visible': { outline: (t) => `2px solid ${t.palette.primary.main}` }
          }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
            {y.year}
          </Typography>
        </ButtonBase>
      ))}
      {hover && (
        <>
          <Box
            sx={{
              position: 'absolute',
              top: hover.y,
              left: 0,
              right: 0,
              height: 2,
              bgcolor: 'primary.main',
              pointerEvents: 'none'
            }}
          />
          <Box
            sx={{
              position: 'absolute',
              top: hover.y - 14,
              right: 60,
              px: 1.25,
              py: 0.5,
              borderRadius: 1,
              whiteSpace: 'nowrap',
              bgcolor: 'primary.main',
              color: 'primary.contrastText',
              boxShadow: 2,
              pointerEvents: 'none',
              zIndex: 2
            }}
          >
            <Typography variant="caption" sx={{ fontWeight: 600 }}>
              {monthLabel(hover.month.month)}
            </Typography>
          </Box>
        </>
      )}
    </Box>
  )
}
