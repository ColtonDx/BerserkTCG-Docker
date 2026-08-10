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

> Status: playable end to end. Setup, mulligans, the five-phase turn, setting
> and opening cards, movement, the Battle phase, card abilities and the win
> conditions all work, and there is a working deckbuilder over all 448 cards.
> See [CLAUDE.md](CLAUDE.md) for the full picture and [TODO.md](TODO.md) for
> the running list.

## Where it runs

**The dev server is `10.10.100.36`**, and it is the only deployment. Open it
at:

| What          | URL                             |
| ------------- | ------------------------------- |
| The game      | http://10.10.100.36:3001        |
| Server health | http://10.10.100.36:3001/health |

One port, because that host runs the **production** stack — a single container
serving the API and the built client same-origin. `:5173` is the dev stack's
Vite port and exists only on a machine running `docker-compose.yml` locally.

`localhost` in the commands below refers to whatever machine you run them on.
Running `docker compose up` somewhere else is not a deploy: it builds a
private stack with its own database and its own matches, invisible to anyone
else.

## Quick start

### Docker (recommended)

```bash
cp .env.example .env
docker compose up --build
```

That gives you a local dev stack for iterating — see
[Deploying](#deploying) for getting a change onto the dev server.

Both services hot-reload on file changes, so ordinary edits need no rebuild;
rebuild when dependencies or the Dockerfile change.

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

One container serves the API and the built client on port 3001, same-origin,
so it needs no CORS allowance. This is what the dev server runs.

## Deploying

The deployment at `/home/dxadmin/berserk-tcg` on `10.10.100.36` is a **file
copy, not a git checkout**, so there is nothing to pull there. Push, then
sync and rebuild:

```bash
rsync -az --delete \
  --exclude '.git' --exclude 'node_modules' --exclude 'dist' --exclude '.env' \
  -e "ssh -i ~/.ssh/dxadmin_id_rsa" \
  ./ dxadmin@10.10.100.36:/home/dxadmin/berserk-tcg/

ssh -i ~/.ssh/dxadmin_id_rsa dxadmin@10.10.100.36 \
  'cd /home/dxadmin/berserk-tcg && docker compose -f docker-compose.prod.yml up -d --build'
```

**Keep `.env` excluded.** The copy on the server holds that box's real
`SESSION_SECRET` and `POSTGRES_PASSWORD` — replacing it signs out every
account and breaks the database login — and its `CORS_ORIGIN` names the host
URL the browser actually sends.

The production image bakes the client in, so every change needs the rebuild
above; there is no hot-reload. Confirm it took by checking the host, not
`localhost`:

```bash
curl -s http://10.10.100.36:3001/health
```

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
