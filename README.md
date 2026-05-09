# Map y Ffoto

An interactive map for organising geotagged photos and hand-drawn routes. Photos are placed automatically using their GPS EXIF data; nearby photos are grouped into a single point of interest. Routes can be drawn over any map layer, linked to photo locations, and edited interactively.

## Features

- **Photo POIs** — drop photos onto the map; GPS EXIF data places them automatically. Photos without GPS go to the current map centre. Nearby photos (within 10 m) are merged into one POI.
- **Map layers** — Topographic (default), OpenStreetMap, ESRI Aerial, and (with a MapTiler key) the NLS historic 6-inch OS survey. Zooming past a layer's native resolution switches automatically to Aerial and back.
- **Route editing** — draw multi-node routes, link nodes to POIs, insert nodes by clicking a route line, split routes, recolour routes per-route.
- **Edit / view modes** — all edits require a password (or Google/Microsoft OAuth). View mode is the default on load; the session is remembered.
- **Bulk upload** — drag a folder of photos onto the map; GPS is extracted client-side before scaling so EXIF survives compression.
- **POI labels** — titles appear as map labels at zoom ≥ 13, auto-positioned to avoid map edges.
- **Photo annotations** — each photo can have a caption, a direction tag (1 or 2), and a positioned arrow marker (↓ ← →) placed by clicking on the photo in the lightbox.
- **Direction preference** — a toolbar control (All / 1 / 2) sorts preferred-direction photos first within each POI and hides POIs whose photos are all in the opposite direction. When the current route names its directions, the buttons read "To: \<name\>" instead of "1" / "2".
- **Tracking mode** — split-screen photo panel that auto-advances through the photos of whichever POI the map crosshair lands on (within ~40 m, or any POI/cluster icon the crosshair sits over); pause/play, prev/next, and direction-aware filtering all in the panel. On phones, a target button (right edge, 25 vh from the bottom) toggles "live tracking": the map follows the device's GPS so your real location stays under the crosshair.
- **One-tap photo capture** — when signed in on a phone with tracking on, a camera button takes a photo and adds it to whichever POI is at your current location (within ~10 m), or creates a new POI if there isn't one. Useful when you arrive at a place you want to record.
- **Mobile-friendly UI** — at narrow widths the toolbar wraps and the action buttons collapse into a kebab dropdown; the route-editing bar uses its own dropdown that opens upward. "Add to Home Screen" launches the app in standalone mode without browser chrome.
- **In-app help** — a `?` button in the toolbar (or "Help" in the mobile menu) opens a guide; first-time visitors and first-time editors see it automatically.

## Running locally

**Prerequisites:** Node.js 18+

```bash
git clone <repo>
cd photomap
npm install
cp .env.example .env   # then edit .env
npm start
```

Open `http://localhost:3000`.

### `.env` variables

| Variable | Purpose | Default |
|---|---|---|
| `ADMIN_PASSWORD` | Password for Edit Mode | `changeme` |
| `SESSION_SECRET` | Session cookie signing key | `photomap-dev-secret` |
| `MAPTILER_KEY` | Enables NLS Historic OS layer | *(layer hidden)* |
| `PORT` | HTTP port | `3000` |

Data is stored in `photomap.db` (SQLite) and `uploads/` — both are gitignored.

## Deploying to AWS

At low traffic the AWS deployment costs essentially nothing when idle — you pay only for S3 storage of photos.

**Architecture:** Lambda + API Gateway HTTP API → DynamoDB (data) + S3 (photos)

**Prerequisites:**
- [AWS CLI](https://aws.amazon.com/cli/) configured (`aws configure`)
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) (`winget install Amazon.SAM-CLI` on Windows)
- Docker Desktop running (SAM uses it to build Linux-compatible native modules)

### First deploy

```bash
sam build
sam deploy --guided
```

SAM prompts for stack name, region, `AdminPassword`, `SessionSecret`, and optional `MaptilerKey`. Answers are saved to `samconfig.toml` (gitignored).

### Subsequent deploys

```bash
sam build && sam deploy
```

### MapTiler and the NLS historic layer

The NLS tile layer requires a MapTiler API key **with the AWS domain whitelisted**. In [cloud.maptiler.com](https://cloud.maptiler.com) → Account → API keys, add your API Gateway URL (e.g. `https://xxxxxxxxxx.execute-api.eu-west-2.amazonaws.com`) to the key's allowed URLs. The key also needs to allow `localhost:3000` for local development.

## Usage

### Viewing

Clicking a POI marker opens a view depending on its content:

| POI content | Click action |
|---|---|
| Has title or note | Full modal with photos and text |
| Photos only | Lightbox (first photo) |
| Neither | Preview panel |

### Editing

Click **Edit** in the toolbar and enter the password (or sign in via Google/Microsoft). In edit mode:

- **Click the map** to create a new POI (title, notes, photos).
- **Drag a POI marker** to reposition it.
- **Click a POI marker** to edit its title, notes, or photos.
- **Click a photo thumbnail** in the edit dialog to open it in the lightbox and add a caption, set a direction tag (1 or 2), or click anywhere on the photo to place a directional arrow marker (↓ ← →). Changes are buffered and saved when you save the POI.
- **OS Maps button** in the edit dialog opens the POI location in OS Maps Explore.
- **Upload Photos** (toolbar) — bulk-import photos; GPS data is used to place and group them automatically.

### Route editing

Click **Edit Routes** (toolbar in Edit Mode, or shortcut on the right of the bottom Edit Mode bar):

- **Start a route** — click any map location, POI, or existing route start/end node.
- **Click a route line** to insert a node at that point.
- **Click a node** to select it, then use Delete Node, Undo, Split Route, Delete Route, or the colour picker (or the kebab `⋮` dropdown on narrow screens).
- **Drag a node** to reposition it. Dragging close to a POI snaps and links it.
- **Done** — exits route-edit. If you started a new route but only placed one node, that orphan is removed automatically.

## Development

```bash
npm run dev    # nodemon; auto-restarts on file changes
```

The codebase runs in both local and AWS modes from a single source tree — the mode is detected from environment variables at runtime. See `CLAUDE.md` for full architecture notes.
