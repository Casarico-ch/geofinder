# GeoFinder

Deduce the street address of a property from its listing — the listing text and an
array of photos. The listing itself is never looked up (no web/portal search), and
no EXIF or device location is read. The area is deduced purely from the pixels and
the text; the exact parcel is then pinned by matching the property's physical land
against open map, aerial, and building-register data.

## How it works

The Express API (`server/api.ts`) runs two stages with Claude (`claude-opus-4-8`,
vision + adaptive thinking):

**1. Deduce the area** — one reasoning pass over the photos and listing text, with
no tools and nothing looked up:

- **All photos together** — the exterior, the views out of the windows and balcony,
  the street and the entrance are reasoned over as one set, so they triangulate a
  single building rather than being read in isolation.
- **Visual signals** — every legible sign (street names, shop and bus-stop names,
  house numbers, plaques, license plates), architecture and construction era,
  street furniture and sign conventions, language and typography, vegetation,
  terrain and skyline, and **sun direction and shadows** for orientation and
  latitude.
- **Text cues as constraints** — commune/quarter, street fragments or postcode,
  floor and total floors, year built, and proximity claims like "station 100 m
  away" or "5 minutes from the university", each of which narrows where the
  property can be.

**2. Map the land** — when the first stage is neighbourhood-tight or better, the
property's physical land is matched against real geodata around the estimate to pin
the exact parcel. This grounds the deduction against maps — it does **not** search
for the listing:

- An official **swisstopo aerial orthophoto** (SWISSIMAGE) centred on the estimate,
  so the parcel and garden shape, the pool, driveways, roof and shoreline
  structures (pergola, jetty) can be matched visually against the photos.
- The **Swiss building register** (GWR) — nearby official addresses with year built
  and floor count, matched against the listing's stated year/floors/rooms.
- **OpenStreetMap** (Overpass) — addressed and tall building footprints, shoreline,
  marinas and jetties, and amenities, each with distance and bearing.

Corroborating matches upgrade the fix toward a specific building and can supply the
address; contradictions downgrade the confidence. The Swiss sources apply inside
Switzerland; OpenStreetMap is used everywhere. Every result is labelled from
`street`-level down to `region`-level with the clues used, the text read, and the
map evidence matched — an exact address is only returned when the evidence supports
it, otherwise it reports the tightest area it can defend.

The endpoint accepts `{ images: [{ imageBase64, mediaType }], listingText? }` (the
legacy single-photo `{ imageBase64, mediaType, hint }` shape still works).

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
