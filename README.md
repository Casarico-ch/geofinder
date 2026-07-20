# GeoFinder

Find the street address of the place a photo was taken — **purely from what's visible
in the image**, plus an optional free-text note. No EXIF, no GPS tags, no device
location: the photo is re-encoded to a plain JPEG in the browser before upload, so
only the pixels travel.

## How it works

1. **Vision analysis** — the image (and your optional context note) goes to Claude
   (`claude-opus-4-8`, vision + adaptive thinking) with a geolocation prompt. It
   transcribes any legible text (street signs, shop and bus-stop names, house
   numbers) and reads architecture, street furniture, road markings, vegetation,
   terrain and skyline.
2. **Web-search verification** — Claude uses the web-search tool to look up the
   specific clues it reads and resolve them to a real street address and
   coordinates.
3. **Map cross-check** — when the estimate is neighborhood-tight or better, the
   server pulls real OpenStreetMap features around the estimated point (addressed
   buildings, shops, playgrounds and their surfaces, transit stops, high-rises on
   the skyline — each with distance and bearing, via Overpass) and a second Claude
   pass tests the photo against that ground truth: corroborating matches upgrade
   the fix toward a specific building; contradictions downgrade the confidence.
4. **Honest confidence** — every result is labelled from `street`-level down to
   `region`-level, with the clues used, the text read from the image, the map
   features matched, the reasoning, and the sources.

Coordinates are reverse-geocoded to a clean address via OpenStreetMap / Nominatim
through the Express API (`server/api.ts`) — no map API key needed.

## Stack

React 19 + Vite + Tailwind 4 + shadcn/ui on the client, Express + the Anthropic
SDK on the server.

## Development

```bash
pnpm install
pnpm dev        # Vite client on :3000 (proxies /api → :3001)
pnpm dev:api    # Express API on :3001 (runs the vision endpoint)
```

## Production

```bash
pnpm build && pnpm start   # serves client + API from one process
```

The vision endpoint requires `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) in the
server environment. Without a key it returns a clear 503 and the UI explains why.
