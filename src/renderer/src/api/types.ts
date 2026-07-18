export type MediaKind = 'image' | 'video'

export interface MediaItem {
  id: number
  filename: string
  kind: MediaKind
  width: number | null
  height: number | null
  taken_at: string | null
  thumb_path: string | null
  is_favorite: boolean
  is_archived?: boolean
  is_hidden?: boolean
  gps_lat?: number | null
  gps_lon?: number | null
  score?: number
}

export interface MediaDetail extends MediaItem {
  path: string
  size_bytes: number | null
  camera_make: string | null
  camera_model: string | null
  taken_at: string | null
  tags: { kind: string; label: string; confidence: number }[]
  people: { id: number; name: string | null }[]
}

export interface MediaPage {
  total: number
  offset: number
  limit: number
  items: MediaItem[]
}

export interface Person {
  id: number
  name: string | null
  cover_media_id: number | null
  cover_thumb: string | null
  is_hidden: boolean
  photo_count: number
}

export interface Album {
  id: number
  name: string
  is_smart: number
  cover_media_id: number | null
  cover_thumb: string | null
  count: number
  created_at: string
}

export interface Folder {
  id: number
  path: string
  added_at: string
  last_scan: string | null
}

export interface LibraryStats {
  total: number
  favorites: number
  archived: number
  hidden: number
  trashed: number
  people: number
}

export interface ScanState {
  scan: {
    running: boolean
    total: number
    processed: number
    added: number
    current_folder: string | null
  }
  ai: { running: boolean; processed: number; total: number }
}

export type LibraryView = 'photos' | 'favorites' | 'archive' | 'hidden' | 'trash'
export type SortKey = 'newest' | 'oldest' | 'favorites' | 'added'
