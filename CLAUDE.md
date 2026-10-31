# GeoFinder

Deduces the street address of a property from its listing: a Vite + React client (`client/`) and an
Express API (`server/`), deployed on Railway (`railway.json`).

## Commands

```bash
pnpm install     # install dependencies
pnpm format      # Prettier, write (CI runs format:check)
pnpm check       # typecheck (tsc --noEmit, client, server and scripts)
pnpm lint        # oxlint, type-aware (errors fail CI)
pnpm knip        # unused files, dependencies and exports
pnpm test        # every scripts/check-*.ts suite
pnpm build       # client + server bundle
                 # CI (.github/workflows/check.yml) runs format:check and these five on Node 24 (.nvmrc)
pnpm dev         # client dev server
pnpm dev:api     # API dev server on :3001
```

## UI rules

- Build every UI element from shadcn/ui (`client/src/components/ui`, style `new-york`, see
  `components.json`): Button, Card, Table, Badge, Checkbox, Select, Input, Label, Dialog, Tooltip…
  When a component is missing, add it with `npx shadcn@latest add <name>`; never hand-roll a
  native `<select>`, `<input type="checkbox">`, `<table>` or a custom pill instead.
- Colour comes from the theme tokens in `client/src/index.css` (`bg-card`, `text-muted-foreground`,
  `border`, `primary`…). Semantic status colours (found / warning / error) are the only extra hues.

## Talking to Daniel

Daniel, 22.10.2026 (chat): "I'm not a developer, I don't know much about
coding, please keep that in mind when talking to me, always take me with you as
a non-technical product manager."

- Explain what changed for the product and its users, not how the code does it.
  Lead with what Daniel can now see or do, and what is still missing.
- Use plain words. When a technical term is unavoidable, say what it means in
  one short clause the first time.
- Leave out file names, function names and code unless Daniel asks. When he has
  to run something himself, give the exact command and say what it does.
- When a decision is his, lay out the options as product trade-offs (what
  users get, what it costs, what it risks) with your recommendation first.
- Daniel, 31.10.2026 (chat): he wants minimalistic code, never
  over-engineered, and every change thought through in its whole context
  rather than implemented blindly.

## Definition of done

A change is finished when all of this holds, in the same pull request:

- The root cause is fixed now, not worked around or left for later.
- Each fix has a check that failed before it, in `scripts/check-*.ts` (run by
  `pnpm test`): an end-to-end or smoke check of the flow it protects.
- The gates are green: `pnpm format:check`, `pnpm check`, `pnpm lint`,
  `pnpm knip`, `pnpm test`, `pnpm build`, and CI's `check` on the pull request.
- One feature per pull request, reversible on its own.
- CLAUDE.md and the `docs/` file of the subject follow in that pull request.

## Two house rules shared with the sibling repositories

Both come from `Casarico-ch/casarico`'s CLAUDE.md (Rules 5 and 6), the house
rules every repository follows:

- **Fail closed.** A guard, an auth check or a verifier returns the restrictive
  result on error (deny, block, reject); it never fails open.
- **One feature per PR.** Everything a feature needs ships together; an
  unrelated fix, refactor or second feature is its own pull request.

## CI tests only the change, and stays minimal

Daniel, 15.10.2026 (chat): "I want all CI tests to run in parallel / I want
CIs only for the flows that were impacted from my changes / please cleanup
all tests, remove all unit tests and only add endtoend tests and smoketests
for important flows." Daniel, 31.10.2026 (chat): "I want a new PR to test
only the changes I made and to always keep the CI to the minimum without
compromising quality."

- A pull request runs a short smoke set plus only the checks its diff
  impacts, in parallel. Nothing more.
- A merge does not re-run what the PR already proved green on the same
  commit. One full run per day on the main branch is the safety net.
- A new check is added only when it proves something no existing check
  proves. New tests are end-to-end or smoke tests of important flows.

How `.github/workflows/check.yml` does it: three parallel jobs (`static`:
format, types, lint, knip; `test`; `build`), on a pull request and on a push
to main only, so a PR branch is no longer checked twice; `check` is the one
status to require. There is no fuller suite than these six commands, so no
daily run is needed, and no job is skipped by path: `tsc`, `knip` and the build
read the whole repository.
Not yet done: a merge to main re-runs the three jobs on the merge commit,
whose sha differs from the PR's; skipping it would need a lookup of the PR's
run, more tooling than the saving is worth.

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
