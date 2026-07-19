import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  Box,
  Drawer,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
  Divider,
  Chip
} from '@mui/material'
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary'
import PeopleIcon from '@mui/icons-material/People'
import SearchIcon from '@mui/icons-material/Search'
import PublicIcon from '@mui/icons-material/Public'
import CollectionsBookmarkIcon from '@mui/icons-material/CollectionsBookmark'
import FavoriteIcon from '@mui/icons-material/Favorite'
import ArchiveIcon from '@mui/icons-material/Archive'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import DeleteIcon from '@mui/icons-material/Delete'
import SettingsIcon from '@mui/icons-material/Settings'
import { api } from '../api/client'
import type { LibraryStats } from '../api/types'

const WIDTH = 236

interface NavEntry {
  to: string
  label: string
  icon: JSX.Element
  countKey?: keyof LibraryStats
}

const NAV: NavEntry[] = [
  { to: '/photos', label: 'Photos', icon: <PhotoLibraryIcon />, countKey: 'total' },
  { to: '/people', label: 'People', icon: <PeopleIcon />, countKey: 'people' },
  { to: '/search', label: 'Search', icon: <SearchIcon /> },
  { to: '/places', label: 'Places', icon: <PublicIcon /> },
  { to: '/albums', label: 'Albums', icon: <CollectionsBookmarkIcon /> },
  { to: '/favorites', label: 'Favorites', icon: <FavoriteIcon />, countKey: 'favorites' },
  { to: '/archive', label: 'Archive', icon: <ArchiveIcon />, countKey: 'archived' },
  { to: '/hidden', label: 'Hidden', icon: <VisibilityOffIcon />, countKey: 'hidden' },
  { to: '/trash', label: 'Trash', icon: <DeleteIcon />, countKey: 'trashed' }
]

export default function Sidebar(): JSX.Element {
  const [stats, setStats] = useState<LibraryStats | null>(null)
  const location = useLocation()

  useEffect(() => {
    api.stats().then(setStats).catch(() => setStats(null))
  }, [location.pathname])

  return (
    <Drawer
      variant="permanent"
      sx={{
        width: WIDTH,
        flexShrink: 0,
        '& .MuiDrawer-paper': {
          width: WIDTH,
          boxSizing: 'border-box',
          borderRight: (t) => `1px solid ${t.palette.divider}`
        }
      }}
    >
      <Box sx={{ px: 2.5, py: 2.5, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box
          sx={{
            width: 30,
            height: 30,
            borderRadius: '50%',
            background: 'linear-gradient(135deg,#4285f4,#a142f4,#ea4335)'
          }}
        />
        <Typography variant="h6" sx={{ fontWeight: 700, letterSpacing: 0.3 }}>
          Memora
        </Typography>
      </Box>
      <Divider />
      <List sx={{ px: 1, py: 1 }}>
        {NAV.map((item) => (
          <ListItemButton
            key={item.to}
            component={NavLink}
            to={item.to}
            sx={{
              borderRadius: 3,
              mb: 0.25,
              '&.active': {
                bgcolor: (t) =>
                  t.palette.mode === 'dark' ? 'rgba(138,180,248,0.16)' : 'rgba(26,115,232,0.1)',
                color: 'primary.main',
                '& .MuiListItemIcon-root': { color: 'primary.main' }
              }
            }}
          >
            <ListItemIcon sx={{ minWidth: 40 }}>{item.icon}</ListItemIcon>
            <ListItemText primary={item.label} />
            {item.countKey && stats && stats[item.countKey] > 0 && (
              <Chip label={stats[item.countKey]} size="small" variant="outlined" />
            )}
          </ListItemButton>
        ))}
      </List>
      <Box sx={{ flex: 1 }} />
      <Divider />
      <List sx={{ px: 1, py: 1 }}>
        <ListItemButton
          component={NavLink}
          to="/settings"
          sx={{ borderRadius: 3, '&.active': { color: 'primary.main' } }}
        >
          <ListItemIcon sx={{ minWidth: 40 }}>
            <SettingsIcon />
          </ListItemIcon>
          <ListItemText primary="Settings" />
        </ListItemButton>
      </List>
    </Drawer>
  )
}
