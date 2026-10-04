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
  tags: { id: number; kind: string; label: string; confidence: number }[]
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
  ai: AiStatus
}

export interface GpuInfo {
  name: string
  vendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'other'
  memory_mb: number | null
  driver: string | null
}

/** Hardware + AI backend status from GET /api/system. */
export interface SystemInfo {
  device: 'cuda' | 'directml' | 'coreml' | 'cpu'
  is_gpu: boolean
  providers: string[]
  gpus: GpuInfo[]
  onnxruntime: string | null
  recommended_package: string | null
  reason: string
  insightface_installed: boolean
  active_backend: 'stub' | 'insightface' | null
  active_providers: string[]
  gpu_in_use: boolean
}

export interface Place {
  key: string
  lat: number
  lon: number
  count: number
  cover_id: number
  latest: string | null
}

export interface RelationNode {
  id: number
  name: string | null
  cover_media_id: number | null
  photo_count?: number
}
export interface RelationEdge {
  id: number
  person_a: number
  person_b: number
  label: string
  directed: number
}
export interface RelationGraph {
  nodes: RelationNode[]
  edges: RelationEdge[]
}
export interface RelationSuggestion {
  a: number
  b: number
  shared: number
  a_name: string | null
  b_name: string | null
}
export interface FamilySuggestion {
  parent: number
  child: number
  parent_age: number
  child_age: number
  gap: number
  shared: number
  parent_gender: string | null
  parent_name: string | null
  child_name: string | null
}

export type LibraryView = 'photos' | 'favorites' | 'archive' | 'hidden' | 'trash'
export type SortKey = 'newest' | 'oldest' | 'favorites' | 'added'

export interface Folder {
  id: number
  path: string
  added_at: string
  last_scan: string | null
  watch?: number
}

export interface AiStatus {
  running: boolean
  processed: number
  total: number
  failed: number
  paused: boolean
  cancelling: boolean
  current: string | null
  finished_at: string | null
}

export interface ProcessingStages {
  total: number
  images: number
  videos: number
  thumbnails: number
  hashed: number
  faces_media: number
  faces_total: number
  ocr: number
  embeddings: number
  ai_processed: number
  failed: number
  duplicates: number
}

export interface ProcessingSnapshot {
  scan: ScanState['scan']
  ai: AiStatus
  watch: { running: boolean; watched: number; added_total: number; last_check: string | null }
  stages: ProcessingStages
}

export interface FailedMedia {
  id: number
  filename: string
  ai_error: string
}

export interface PrivacyInfo {
  local_ai: boolean
  ai_backend: string
  uploads_enabled: boolean
  network: {
    tile_requests: number
    tiles_cached: number
    tiles_bytes: number
    description: string
  }
  storage: { name: string; path: string; bytes: number }[]
}

export interface DuplicateItem extends MediaItem {
  path: string
  size_bytes: number | null
}

export interface DuplicateGroup {
  hash: string
  items: DuplicateItem[]
}

export interface TimelineMonth {
  month: string | null
  count: number
  offset: number
}

export interface SearchSuggestions {
  people: { id: number; name: string; count: number }[]
  tags: { label: string; count: number }[]
}

export type MediaFlag = 'is_favorite' | 'is_archived' | 'is_hidden' | 'is_trashed'
