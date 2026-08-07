# Berk TCG
All Rights, images, etc., belong to Kentaro Miura, Studio Gaga, Konami.
This is a fan based project to keep the memory and playability of the Berserk TCG alive.
Always keep struggling.

A browser-based, Docker-hosted way to play the Berserk trading card game
(Konami, 2003 — based on Kentaro Miura's _Berserk_).

Two players fight over a shared row of five City cards. You win by occupying
three cities at once including the Royal Capital, or by decking your opponent.
The engine enforces the rules — turns, phases, City-Level gating, costs, and
legal moves are handled by the software, so playing feels like a video game
rather than a tabletop simulator.

> Status: playable skeleton. Setup, mulligans, the five-phase turn, setting and
> opening cards, movement, and the win conditions all work, and there is a
> working deckbuilder over all 448 cards. The Battle phase and card abilities
> are the next things to build — see [CLAUDE.md](CLAUDE.md) for the full
> picture and [TODO.md](TODO.md) for the running list.

## Quick start

### Docker (recommended)

```bash
cp .env.example .env
docker compose up --build
```

- Client: http://localhost:5173
- Server: http://localhost:3001/health

Both services hot-reload on file changes.

### Local Node

Requires Node 22+.

```bash
npm install
npm run dev
```

### Production build

```bash
docker compose -f docker-compose.prod.yml up --build
```

One container serves the API and the built client on http://localhost:3001.

## Playing a match

Open the client in two browser windows (one can be a private window, so they
get separate player identities). Click **Find / create match** in the first;
the second either does the same — it will be paired into the open match — or
joins with the match id shown on screen.

## Layout

| Path                | Purpose                                               |
| ------------------- | ----------------------------------------------------- |
| `packages/engine`   | Pure, deterministic rules engine — no I/O             |
| `packages/protocol` | Wire types shared by server and client                |
| `apps/server`       | Fastify + Socket.IO match host (authoritative)        |
| `apps/web`          | React + Vite client                                   |
| `Docs/`             | Rules, design notes and deckbuilding limits           |
| `db/init/`          | Schema and card seed, run when Postgres first starts  |
| `art-assets/`       | Wallpaper, card scans (`PDFs/`), cut cards (`cards/`) |
| `scripts/`          | Asset tooling, e.g. `extract-cards.py`                |

## Development

```bash
npm test           # run the test suite
npm run typecheck  # type-check the whole monorepo
npm run build      # build everything
npm run format     # prettier
```

## Notes

Berserk is the property of Konami and Kentaro Miura's estate. This project is
an unofficial, non-commercial implementation; card art and rules text are not
included in the repository.
