# GeoFinder

Deduce the street address of a property from its listing — **purely from what you
give it**: the listing text and an array of photos. Nothing is looked up. No web
search, no map database, no geocoder, no EXIF or device location — only the pixels
and the text.

## How it works

The Express API (`server/api.ts`) sends the photos and listing text to Claude
(`claude-opus-4-8`, vision + adaptive thinking) in a single reasoning pass with no
tools, and Claude deduces the location from the evidence alone:

- **All photos together** — the exterior, the views out of the windows and balcony,
  the street and the entrance are reasoned over as one set, so they triangulate a
  single building rather than being read in isolation.
- **Visual signals** — every legible sign (street names, shop and bus-stop names,
  house numbers, plaques, license plates), architecture and construction era,
  street furniture and sign conventions, language and typography, vegetation,
  terrain and skyline, and **sun direction and shadows** for orientation and
  latitude.
- **Text cues as constraints** — commune/quarter, street fragments or postcode,
  floor and total floors (building height), year built, and proximity claims like
  "station 100 m away" or "5 minutes from the university", each of which narrows
  where the property can be.
- **Honest confidence** — every result is labelled from `street`-level down to
  `region`-level, with the clues used, the text read from the photos, and the
  reasoning. An exact address is only returned when the evidence carries a locking
  signal; otherwise it reports the tightest area it can defend.

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
