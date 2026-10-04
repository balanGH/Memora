# Memora

A modern, **fully offline** desktop photo-management app inspired by Google Photos.
Everything — your files, metadata, thumbnails, and AI results — stays on your machine.
No cloud, no telemetry, no tracking.

> **Status: working app.** The end-to-end core runs today: add folders → scan → generate
> thumbnails → browse a Google-Photos-style timeline → open the full-screen viewer (photos
> **and video**, including HEIC). People (merge / split / choose-thumbnail / hide+unhide),
> an interactive **Places** map with a **heatmap**, a **Relations** graph (interactive +
> tree view, with automatic co-occurrence and age-based family suggestions), Albums (bulk
> picker + add-from-viewer), editable per-photo **Tags**, Search, and per-person **Export**
> (preserving folder structure) all work. Object/scene tagging, OCR, and CLIP-style search
> run on **deterministic stub models** so the app runs with zero multi-GB downloads;
> **real InsightFace face recognition** (with age/gender for family suggestions) is wired and
> flips on with one env var. Swapping in real YOLO / CLIP / PaddleOCR later requires no
> changes to callers.

## Architecture

```
┌────────────────────────── Electron (main process) ──────────────────────────┐
│  • Spawns the Python backend on localhost      • Native folder picker       │
│  • Creates the app window                      • System theme detection     │
└───────────────┬─────────────────────────────────────────────────────────────┘
                │ contextBridge (preload)
┌───────────────▼──────────────┐        HTTP (127.0.0.1)        ┌────────────────┐
│  Renderer: React + TS + MUI  │  ───────────────────────────►  │  FastAPI (Py)  │
│  • Timeline (virtual scroll) │                                │  • SQLite      │
│  • Photo viewer / People /   │  ◄───────────────────────────  │  • Scanner     │
│    Search / Albums / Settings│        JSON + image bytes      │  • AI pipeline │
└──────────────────────────────┘                                └────────────────┘
```

- **Frontend:** Electron + React + TypeScript + Material UI, bundled with `electron-vite`.
  Virtualized timeline via `react-virtuoso`, justified (masonry-style) rows, sticky date
  headers, dark/light themes. Interactive **Places** map (Leaflet) with a timeline filmstrip
  synced to the map; tiles are served by the backend, so the renderer stays local-only.
- **Backend:** Python + FastAPI + SQLite (stdlib `sqlite3`, WAL mode). Pillow for EXIF,
  thumbnails, and HEIC→JPEG display renditions; optional ffmpeg for video; an OSM tile
  proxy with an on-disk cache for the Places map.
- **AI seam:** `backend/app/ai/interfaces.py` defines `Protocol`s for faces, tagging, OCR,
  and embeddings. `stub.py` implements them deterministically today.

## Prerequisites

- **Node.js** 18+ and npm
- **Python** 3.10+ on your `PATH`

## Setup

```bash
# 1. Frontend dependencies
npm install

# 2. Backend virtualenv + dependencies
npm run backend:install
# (equivalent to: python -m venv backend/.venv &&
#  backend/.venv/Scripts/python -m pip install -r backend/requirements.txt)
```

## Run

```bash
npm run dev
```

`electron-vite dev` launches the desktop app. The Electron main process automatically
starts the FastAPI backend (preferring `backend/.venv`), so you do **not** need a
separate terminal.

Then, in the app:

1. Go to **Settings → Add folder** and pick a folder of photos.
2. Click **Scan for new media** — thumbnails generate and the timeline fills in.
3. Click **Run AI processing** — faces cluster into **People**, and objects/scenes/OCR
   become searchable. Try searching `dog`, `beach`, or `sunset`.

### Running the backend on its own

```bash
npm run backend:dev          # python backend/run.py
# API served at http://127.0.0.1:8756  (docs at /docs)
```

## Media support

- **HEIC / HEIF / TIFF / BMP** — browsers can't render these directly, so the viewer
  requests `GET /api/display/{id}`, which serves the original for web-safe formats
  (JPEG/PNG/WebP/GIF) and converts the rest to a cached JPEG. HEIC decoding needs
  `pillow-heif` (`pip install pillow-heif`); thumbnails and display both use it.
- **Video (.mp4/.mov/.mkv/.webm/…)** — plays in the full-screen viewer via a native
  `<video>` element with range-request seeking. With **ffmpeg** on `PATH`, Memora also
  extracts a poster-frame thumbnail and samples frames to detect faces in videos; without
  ffmpeg, videos still play and show a placeholder tile (they stay queued for AI until
  ffmpeg is installed).

## Places (interactive map)

The **Places** tab shows every photo with GPS EXIF data on a real, pannable/zoomable map
(Leaflet + OpenStreetMap tiles) with a synchronized **timeline filmstrip**:

- Scroll the filmstrip and the map **flies** to where each photo was taken.
- Click a **map pin** to jump the timeline to that photo.
- **Double-click** a filmstrip photo to open it full-screen.

**Heatmap vs. Pins.** A **Heatmap / Pins** toggle switches between a density heatmap (warmer
= more photos in an area; the brush scales with zoom so points don't balloon when zoomed out)
and classic clickable pins. As you scroll the timeline — or click the heatmap — a small photo
**preview card** pops up at that location so you always know which photo you're on. A
**Newest / Oldest** toggle controls the filmstrip order (`GET /api/geo/media?sort=newest|oldest`).
The heatmap is a self-contained canvas layer — no external library — so it stays offline and
CSP-safe.

Backend: `GET /api/geo/media` returns geotagged photos (newest-first by default; the timeline
that drives the map). Photos need GPS EXIF (usually from a phone camera) to appear.

**Tile caching (offline after first view).** The map never talks to the internet directly.
Leaflet requests tiles from the local backend (`GET /api/tile/{z}/{x}/{y}`); on a cache
miss the backend fetches that one tile from OpenStreetMap, stores it under
`~/.memora/tiles/z/x/y.png`, and serves it. Revisiting an area — including fully offline and
after a restart — is served from disk with no network access; an uncached tile while offline
just shows blank. Manage/clear the cache in **Settings → Map cache** (`GET /api/tiles/stats`,
`POST /api/tiles/clear`).

> **Network note:** the **only** outbound traffic is the backend fetching map tiles on a
> cache miss (with a descriptive User-Agent per OSM's tile policy). The renderer only ever
> talks to `127.0.0.1`, and your photos, files, and metadata never leave the machine.

## People management

The **People** page clusters faces automatically; you correct the grouping directly:

- **Merge** — enter "Merge duplicates", select two or more heads that are the same person,
  and merge them into one (a named person is kept as the merge target so the name survives).
- **Split (Fix grouping)** — on a person's page, select photos that are *not* this person and
  move them to a new person. The inverse of merge.
- **Choose thumbnail** — click the avatar (✏️) on a person's page to pick which photo supplies
  their face crop; the default is the largest detected face.
- **Hide / Unhide** — hide a person from the person page; a **Hidden (N)** toggle on the People
  page reveals hidden people with an **Unhide** button.

Endpoints: `POST /api/people/merge`, `POST /api/people/{id}/split`, `POST /api/people/{id}/cover`,
`GET /api/people/{id}/face?media_id=…` (the picker crops each candidate photo), `POST /api/people/{id}/hide`.

## Relations (people graph + family tree)

The **Relations** tab links people with labeled relationships and visualizes them:

- **Add / edit** a relation from a **grid of faces** (pick person → relationship → related
  person). Relationship presets — **Parent of / Child of** (directed, drawn with arrows),
  **Spouse, Sibling, Friend, Colleague, Custom** — are color-coded, shown in a grid.
- **Interactive graph** — a self-contained force-directed layout: drag faces, scroll to zoom,
  drag the background to pan, hover to focus a person's connections, click a face to open that
  person. A **Recenter** button always brings the view back.
- **Tree view** — a **Graph / Tree** toggle lays directed parent→child links into generation
  rows (parents on top); spouses/siblings/friends stay on the same level.
- **Auto-connect** — one click links everyone who appears together in at least *N* photos
  (face co-occurrence), labeled "appears with" for you to rename. Photos reveal *who* is
  connected, never the *type*.
- **Suggestions** — "often photographed together" (co-occurrence) and, with the real backend,
  **"possible parent → child"** from estimated ages. Suggestions are hints to confirm, never
  auto-applied.
- **Manage** — the relationships list supports per-row **edit** / **delete**, multi-select
  **Delete selected**, and **Clear all**.

Backend: `relationships` table (undirected pairs, optional `directed` flag); faces carry
optional `age` / `gender` (real backend only) for family suggestions. Endpoints:
`GET/POST /api/relations`, `DELETE /api/relations/{id}`, `GET /api/relations/suggestions`,
`GET /api/relations/family-suggestions`, `POST /api/relations/auto`.

## Editable tags

Open a photo → **info (i)** → **Tags**. AI tags can be wrong (e.g. a group photo tagged
"beach"), so each tag has an **✕ to delete** and there's an **"Add a tag"** field. Changes
persist to SQLite immediately. Endpoints: `POST /api/media/{id}/tags`,
`DELETE /api/media/{id}/tags/{tag_id}`.

## Albums

Create an album on the **Albums** page, then add photos two ways:

- **Bulk** — open the album → **Add photos** → multi-select from a library picker (photos
  already in the album are marked).
- **While browsing** — in the photo viewer, **Add to album** (📚) files the current photo into
  an existing album or a new one.

Endpoints: `POST /api/albums`, `POST /api/albums/{id}/media` (idempotent; auto-sets the cover).

## Export people with folder structure

From a person's page, **Export** copies all of that person's photos to a destination you
pick, **mirroring each photo's path relative to its library root** — so event subfolders
are preserved. A person appearing in both `Events/college/IndustrialVisit` and
`Events/college/Symposium` exports into *both* subfolders. Backend:
`POST /api/export/person`.

## Data & privacy

All state lives in **`~/.memora/`**:

- `memora.db` — SQLite index (folders, media, faces, people, tags, albums, relationships)
- `thumbnails/` — cached WebP thumbnails (images + video poster frames)
- `display/` — cached JPEG renditions of HEIC/TIFF/… for the viewer
- `tiles/` — cached OpenStreetMap tiles for the Places map (clear in Settings)

Your original photos are **never moved, modified, or uploaded** (Export explicitly *copies*
to a folder you choose). Delete `~/.memora/` to reset the app completely. Override the
location with the `MEMORA_DATA_DIR` env var.

The **only** outbound network traffic is the backend fetching **map tiles** on a cache miss
for the **Places** tab — see the note above. The renderer talks solely to `127.0.0.1`, and
nothing else in the app makes network requests.

## Build

```bash
npm run build        # type-checks + bundles main, preload, and renderer into out/
npm run typecheck    # TS only
```

## Real AI face recognition (InsightFace)

By default Memora runs with **stubbed** AI, so faces are grouped by a hash of the file
path — the clustering on the People page is arbitrary, not real. To turn on genuine face
detection + recognition (InsightFace `buffalo_l`: detection + 512-d embeddings), follow
the steps below. No frontend, route, or repository code changes are needed — a single
environment variable flips the seam.

### 1. Install the face packages into the backend venv

```bash
npm run backend:install-ai
```

This detects your GPU and installs InsightFace with the matching onnxruntime build:
`onnxruntime-gpu` for NVIDIA, `onnxruntime-directml` for any other GPU on Windows
(Intel Iris Xe / Arc, AMD), or plain `onnxruntime` for CPU and macOS.

#### Automatic GPU detection

At startup the backend checks the hardware (`backend/app/ai/device.py`) and runs the
face model on the best device it can use: CUDA, then DirectML, then CoreML, then CPU.
If onnxruntime can't initialise the GPU it falls back to the CPU. **Settings → Indexing
& AI** shows the GPU it found, which device is in use, and which package to install when a
GPU is present but unused. `GET /api/system` returns the same data. To force a device:

```bash
$env:MEMORA_DEVICE = "cpu"   # or cuda | directml | coreml | auto (default)
```

> **Python version note:** InsightFace and onnxruntime ship prebuilt wheels for
> **Python 3.10–3.12** (3.13 partial). On very new interpreters (3.14) `pip install
> insightface` may try to compile from source and fail. If that happens, create the
> backend venv with a **Python 3.11/3.12** interpreter and reinstall.

### 2. Reset previous stub results

Existing faces/people were clustered with fake embeddings and must be reprocessed. Clear
the AI tables (keeps your folders, favorites, and albums):

```bash
backend/.venv/Scripts/python -c "import os; os.environ.setdefault('MEMORA_DATA_DIR', os.path.expanduser('~/.memora')); from app.db import get_conn; c=get_conn(); c.executescript('DELETE FROM faces; DELETE FROM people; DELETE FROM tags; UPDATE media SET ai_processed=0;'); c.commit(); print('AI data reset')"
```

*(Run it from the `backend/` directory. Or simply delete `~/.memora/memora.db` for a full
wipe.)*

### 3. Launch with the real backend enabled

Once InsightFace is installed it is used automatically (`MEMORA_FACE_BACKEND=auto`, the
default). Set `MEMORA_FACE_BACKEND=stub` to keep the stub, or `insightface` to require it.
The env var is read by the backend and flows through Electron automatically.

```bash
# Windows (PowerShell)
$env:MEMORA_FACE_BACKEND = "insightface"
npm run dev

# macOS / Linux
MEMORA_FACE_BACKEND=insightface npm run dev
```

Then open **Settings → Run AI processing**. The first run downloads the InsightFace model
(~300 MB) to `~/.insightface/models` — that single download needs internet; everything
afterward is fully offline. The backend log prints:

```
[memora.ai] face backend: InsightFace, providers=['DmlExecutionProvider', 'CPUExecutionProvider']
```

Now the **People** page shows real **cropped faces** (via `GET /api/people/{id}/face`),
and the same person's photos genuinely cluster together. The real backend also records each
face's **age** and **gender**, which powers the **"possible parent → child"** family
suggestions on the **Relations** tab (the stub backend has no age data, so that row stays
empty until you reprocess with InsightFace).

### 4. Tune clustering (optional)

Faces are the same person when cosine similarity ≥ a threshold (default **0.45** for
InsightFace). If one person is split across cards, lower it; if different people merge,
raise it:

```bash
$env:MEMORA_FACE_THRESHOLD = "0.38"   # PowerShell; looser grouping
```

### Where the code lives

| Concern | File |
|---------|------|
| Real face model | `backend/app/ai/real.py` — `RealFaceService` |
| Backend selection | `backend/app/ai/__init__.py` — `get_ai()` reads `MEMORA_FACE_BACKEND` |
| GPU detection | `backend/app/ai/device.py` — `detect_device()` reads `MEMORA_DEVICE` |
| Match threshold | `backend/app/ai/interfaces.py` — `AIServices.face_match_threshold` |
| Clustering | `backend/app/ai_pipeline.py` — `_assign_person()` |
| Face crop | `backend/app/media_utils.py` — `crop_face()` + `/api/people/{id}/face` |

### Adding the other models (YOLO / CLIP / PaddleOCR)

Same pattern: implement the matching `Protocol` from `interfaces.py` in a new class, then
wire it into `get_ai()`. The stub tagging/OCR/embedding services stay in place until you
do. No caller changes.

## Feature status

| Area | State |
|------|-------|
| Folder scan, incremental indexing, thumbnails | ✅ Working |
| SQLite metadata, EXIF (date, camera, GPS) | ✅ Working |
| Timeline (day/month/year grouping, sort, virtual scroll) | ✅ Working |
| Full-screen viewer (zoom, pan, EXIF panel, keyboard shortcuts) | ✅ Working |
| Favorites / Archive / Hidden / Trash | ✅ Working |
| Albums — bulk picker + add-from-viewer | ✅ Working |
| Editable per-photo tags (add / delete, persisted) | ✅ Working |
| People clustering, rename, hide + **unhide** | ✅ Working (stub or real InsightFace) |
| People **merge**, **split** (fix grouping), **choose thumbnail** | ✅ Working |
| Real face recognition (InsightFace) + cropped-face avatars | ✅ Wired — used automatically once installed |
| Automatic GPU detection (CUDA / DirectML / CoreML / CPU) | ✅ Working |
| Relations — interactive graph, tree view, edit/delete, suggestions | ✅ Working |
| Relations — auto-connect (co-occurrence) + family (age) suggestions | ✅ Working (age needs real backend) |
| Places — interactive Leaflet map + timeline filmstrip | ✅ Working |
| Places — photo-density **heatmap** + preview cards + sort toggle | ✅ Working |
| Map tiles proxied + cached on disk (offline after first view) | ✅ Working |
| Export a person's photos preserving event folder structure | ✅ Working |
| Search (people / object / scene / OCR / semantic) | ✅ Working (stub) |
| Similar-image search | ✅ Working (stub) |
| Stable media ids + no-cache media responses (thumbnail correctness) | ✅ Working |
| Real YOLO / CLIP / PaddleOCR | 🔌 Interface ready, not wired |
| Non-destructive editing, desktop packaging | 🚧 Planned |

## Keyboard shortcuts (viewer)

`←` / `→` navigate · `+` / `-` zoom · `0` reset zoom · `f` favorite · `i` info · `Esc` close
