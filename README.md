# Memora

A modern, **fully offline** desktop photo-management app inspired by Google Photos.
Everything — your files, metadata, thumbnails, and AI results — stays on your machine.
No cloud, no telemetry, no tracking.

> **Status: working vertical slice.** The end-to-end core runs today: add folders →
> scan → generate thumbnails → browse a Google-Photos-style timeline → open the
> full-screen viewer. Face recognition, object/scene tagging, OCR, and CLIP-style
> semantic search are wired through clean service interfaces backed by **deterministic
> stub models**, so the whole app runs with zero multi-GB model downloads. Swapping in
> real InsightFace / YOLO / CLIP / PaddleOCR later requires no changes to callers.

## Architecture

```
┌────────────────────────── Electron (main process) ──────────────────────────┐
│  • Spawns the Python backend on localhost      • Native folder picker          │
│  • Creates the app window                      • System theme detection        │
└───────────────┬───────────────────────────────────────────────────────────────┘
                │ contextBridge (preload)
┌───────────────▼──────────────┐        HTTP (127.0.0.1)        ┌────────────────┐
│  Renderer: React + TS + MUI  │  ───────────────────────────► │  FastAPI (Py)  │
│  • Timeline (virtual scroll) │                                │  • SQLite      │
│  • Photo viewer / People /   │  ◄─────────────────────────── │  • Scanner     │
│    Search / Albums / Settings│        JSON + image bytes      │  • AI pipeline │
└──────────────────────────────┘                                └────────────────┘
```

- **Frontend:** Electron + React + TypeScript + Material UI, bundled with `electron-vite`.
  Virtualized timeline via `react-virtuoso`, justified (masonry-style) rows, sticky date
  headers, dark/light themes.
- **Backend:** Python + FastAPI + SQLite (stdlib `sqlite3`, WAL mode). Pillow for EXIF and
  thumbnails.
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

## Data & privacy

All state lives in **`~/.memora/`**:

- `memora.db` — SQLite index (folders, media, faces, people, tags, albums)
- `thumbnails/` — cached WebP thumbnails

Your original photos are **never moved, modified, or uploaded**. Delete `~/.memora/` to
reset the app completely. Override the location with the `MEMORA_DATA_DIR` env var.

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
backend/.venv/Scripts/python -m pip install insightface onnxruntime opencv-python
# NVIDIA GPU instead of CPU:
#   backend/.venv/Scripts/python -m pip install insightface onnxruntime-gpu opencv-python
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

The `MEMORA_FACE_BACKEND` env var is read by the backend and flows through Electron
automatically.

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
[memora.ai] face backend: InsightFace (real)
```

Now the **People** page shows real **cropped faces** (via `GET /api/people/{id}/face`),
and the same person's photos genuinely cluster together.

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
| Albums (manual) | ✅ Working |
| People clustering, rename, hide, merge | ✅ Working (stub or real InsightFace) |
| Real face recognition (InsightFace) + cropped-face avatars | ✅ Wired — enable via `MEMORA_FACE_BACKEND=insightface` |
| Search (people / object / scene / OCR / semantic) | ✅ Working (stub) |
| Similar-image search | ✅ Working (stub) |
| Real YOLO / CLIP / PaddleOCR | 🔌 Interface ready, not wired |
| Video thumbnails, non-destructive editing, GPS map view, packaging | 🚧 Planned |

## Keyboard shortcuts (viewer)

`←` / `→` navigate · `+` / `-` zoom · `0` reset zoom · `f` favorite · `i` info · `Esc` close
