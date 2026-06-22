# swarm-office

> Open-source pixel-art virtual office where your team — **and your AI agents** — share the same space.

Self-hostable 2D multiplayer office: walk around, gather in zones, chat, and work together.
Built so that **AI agents (M.IA / Predicta) can live in the office as NPCs** alongside humans —
the "swarm" angle that sets it apart from a plain Gather/WorkAdventure clone.

**Status:** 🚧 early scaffold. F0 (walk + presence + text chat) is in progress and spans multiple
sessions — see [`docs/SPEC.md`](docs/SPEC.md) for the roadmap.

## Why

Recreate the remote-office feel YourTechTribe had with Gather, but **open-source, owned, and
agent-native**. WorkAdventure gives you the office but not the agents; DeskRPG gives you agents
but is text-only with an unclear license. `swarm-office` is built from scratch (MIT) to combine
both — team presence **and** AI teammates in one pixel world.

## Stack

| Layer | Tech | Why |
|-------|------|-----|
| Client render | **Phaser 4** (WebGL) + **Vite + React** shell | 2D engine on GPU; lightweight SPA shell |
| Multiplayer | **Colyseus** (authoritative, schema state-sync) | rooms + delta-sync + interest management out of the box |
| Voice/video (F1) | **LiveKit** (self-host) | open-source proximity audio/video |
| Persistence | **Postgres** + Drizzle | maps, users, layouts |
| Maps | **Tiled** | standard tilemap editor |
| AI NPCs (F2) | M.IA gateway hook | agents as office citizens |

## Roadmap

- **F0** — walk + presence + zones + text chat _(current — local movement + Colyseus presence done)_
- **F1** — voice/video proximity (LiveKit)
- **F2** — AI agents as NPCs (M.IA gateway)
- **F3** — scale: interest management (AOI), Tiled map editor, OIDC/members

Deployment target: local first, then a single GCP VM (Docker Compose), scaling to Cloud Run +
Cloud SQL + LiveKit later. **No infra is provisioned until there is something to host.**

## Prior art / reference

[**DeskRPG**](https://github.com/dandacompany/deskrpg) (Phaser + Socket.IO + Next.js, AI NPCs) is
studied as a **reference for UX and the NPC pattern only**. ⚠️ **No code is copied from DeskRPG** —
its license is `NOASSERTION` (no usable open-source grant). `swarm-office` is an independent,
clean-room MIT implementation. [WorkAdventure](https://github.com/workadventure/workadventure) is
the reference for the video-proximity experience.

## License

[MIT](LICENSE) © 2026 YourTechTribe
