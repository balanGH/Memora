import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Box, Typography, Avatar, Grid, Card, CardActionArea } from '@mui/material'
import PersonIcon from '@mui/icons-material/Person'
import { api, thumbUrl } from '../api/client'
import type { Person } from '../api/types'

export default function PeoplePage(): JSX.Element {
  const [people, setPeople] = useState<Person[]>([])
  const [loaded, setLoaded] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    api
      .people()
      .then((r) => setPeople(r.people))
      .finally(() => setLoaded(true))
  }, [])

  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 3 }}>
      <Typography variant="h5" sx={{ fontWeight: 600, mb: 0.5 }}>
        People
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Faces are grouped automatically as photos are processed. Click a person to name
        them.
      </Typography>

      {loaded && people.length === 0 && (
        <Typography color="text.secondary">
          No people yet. Scan a folder and let AI processing finish.
        </Typography>
      )}

      <Grid container spacing={2}>
        {people.map((p) => (
          <Grid item key={p.id} xs={6} sm={4} md={3} lg={2}>
            <Card variant="outlined" sx={{ borderRadius: 4 }}>
              <CardActionArea
                onClick={() => navigate(`/people/${p.id}`)}
                sx={{ p: 2, textAlign: 'center' }}
              >
                <Avatar
                  src={p.cover_media_id ? thumbUrl(p.cover_media_id) : undefined}
                  sx={{ width: 92, height: 92, mx: 'auto', mb: 1.5 }}
                >
                  <PersonIcon sx={{ fontSize: 44 }} />
                </Avatar>
                <Typography noWrap sx={{ fontWeight: 600 }}>
                  {p.name ?? 'Add name'}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {p.photo_count} {p.photo_count === 1 ? 'photo' : 'photos'}
                </Typography>
              </CardActionArea>
            </Card>
          </Grid>
        ))}
      </Grid>
    </Box>
  )
}
