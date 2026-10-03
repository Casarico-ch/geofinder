# GeoFinder

Deduces the street address of a property from its listing: a Vite + React client (`client/`) and an
Express API (`server/`), deployed on Railway (`railway.json`).

## Commands

```bash
pnpm install     # install dependencies
pnpm check       # typecheck (tsc --noEmit) — the CI gate, job `check`
pnpm build       # client + server bundle
pnpm dev         # client dev server
pnpm dev:api     # API dev server on :3001
```

## How agents are dispatched into this repository

<!-- rico-agent-contract v2 begin -->
Agents working in this repository are dispatched by the Rico cockpit, the
internal build board of Immo-Ressource AG (owner: Daniel Abebe). A dispatch names
one card and asks you to build it with gStack and report progress on that card.

Reporting goes through the `rico-board` tool (`board_post`, `board_get`) that this
workspace's setup script installs: notes, stage moves and questions for Daniel.
The tool carries the card's credential; you never handle one. If the tool is not
in your tool list, this workspace was set up before it existed: do the work,
commit and push the card branch (the repository's report hook carries your
commits to the board), and say in your final message that the board tool was
missing.

The cockpit never asks for repository secrets, a `.env` file, `GITHUB_TOKEN`,
`DATABASE_URL`, passwords or anything outside the card you are working.

Your gates are declared in this file, next to this block.
<!-- rico-agent-contract v2 end -->

<!-- rico-agent-gates: pnpm install --frozen-lockfile, then pnpm check and pnpm build -->
