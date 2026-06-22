# swarm-office — project conventions

> Auto-loaded when working inside this repo. Read before editing code or running
> any code-modifying skill (`/implement`, `/improve`, `/simplify`, `/refactor`,
> `/code-review`).

## Didactic comments are a FIRST-CLASS DELIVERABLE — never strip them (HARD RULE)

This codebase is built **to learn**: the comments explain *what happens under the
hood* (the browser event loop, the GPU, Phaser's game loop, React's render cycle,
physics integration, the pub/sub bridge…), not just *what* the code does. They are
intentional teaching material, not noise.

**Therefore, on ANY pass over the code — `/simplify`, `/improve`, `/refactor`,
`/code-review`, or a manual edit:**

1. **NEVER remove, condense, or "clean up" the explanatory/teaching comments**
   (the block headers `═══`, the "WHY/UNDER THE HOOD" sections, the numbered
   step comments in `update()`, etc.). They are protected content.
2. A comment may only be **removed** if the code it documents is deleted, or
   **updated** if it became factually wrong after a change — in that case fix the
   comment, do not delete it.
3. **New code MUST be documented the same way**: explain the mechanism and the
   *why*, especially anything non-obvious about the runtime/engine/network.
   Adding a feature without its didactic comments is an incomplete deliverable.
4. Prefer **targeted `Edit`** over full-file rewrites; a rewrite risks dropping
   comments by accident. If you must rewrite a file, carry over **all** prior
   comments verbatim and add the new ones.

This reinforces the workspace-global HARD RULE "Preservar comentarios al editar"
and makes it explicit for code-quality passes that would otherwise trim comments.

## Dependency / supply-chain policy (HARD RULE)

- **Exact version pins** in `package.json` (no `^`/`~`) — production-app hardening
  per post-axios (March 2026) guidance. The `package-lock.json` is committed and
  pins the full transitive tree.
- **Always `npm ci`** for reproducible installs (not `npm install`, which can
  drift the lockfile). Bump versions deliberately (ideally a reviewed
  Dependabot/Renovate PR) and run `npm audit`.

## Stack notes

- **Phaser 4** (migrated from 3.90 on 2026-06-22; SPEC §4 updated). We use only
  standard APIs (no custom pipelines / tint / FX / masks / shaders / lighting),
  so the v3→v4 surface is minimal.
- Phaser game lives **outside** React's render cycle (`client/src/game/PhaserGame.tsx`);
  the two sides talk only through the typed `EventBus` (`client/src/game/EventBus.ts`).
- Code lives here (`~/dev/swarm-office/`, outside Google Drive). Docs/spec are in
  the repo (`docs/SPEC.md` is the source of truth).

## Roadmap (see docs/SPEC.md)

F0 (walk + presence + zones + text chat) is being built in **vertical slices**:
Slice 1 = client scaffold + local player movement (done). Slice 2 = Colyseus
server + presence, remotes interpolated (done). Slice 3 = zones — server owns
membership (player.zone), client renders areas + shows local zone (done). Slice 4
= text chat — transient broadcast, React↔scene↔room over the bus, server-side
input validation (done). **F0 complete.**

**F1 — proximity comms (done):** F1a zone-scoped text chat (filter broadcast by
player.zone) + F1b distance-gated voice (WebRTC **P2P mesh**, audio-only, ≤5, no
LiveKit; signaling over Colyseus, perfect negotiation; connections follow presence,
audio follows distance). Spec: `docs/specs/F1-proximity-comms.md`.

**F2 — AI NPCs:** F2a **done** — a scripted NPC ("M.IA") is a normal `players` entry
(`isNpc=true`) the server spawns + wanders via the first simulation tick; it hears
in-zone chat and replies (scripted), shown with a name label; NPCs get NO VoicePeer
(voice mesh stays human-only). Spec: `docs/specs/F2-ai-npcs.md`. **Next: F2b** — swap
`NpcController.scriptedReply()` for the real M.IA gateway (explore its API first —
spec §5). Then F3 scale (SFU + TURN + video).

## Running the dev stack

Two processes: `cd server && npm run dev` (Colyseus on :2567) and `cd client &&
npm run dev` (Vite on :5173). Open two browser tabs to see presence. Authority
model is **client-authoritative relay** (server owns room state, not movement);
see docs/SPEC.md § "modelo de autoridad".

**Gotcha — `tsx watch` silent failed-rebind:** if the server reload logs
`EADDRINUSE: :::2567`, the OLD listener never released the port, so `tsx` is still
serving the PREVIOUS code even though it printed "Restarting…". Don't trust that
log — kill whatever holds :2567 and restart fresh, or you'll test stale code. (Bit
us once validating an F2 change against the prior build.)

## Networking version lock (HARD RULE)

server `colyseus` and client `@colyseus/sdk` MUST stay on the same 0.17.x line —
the Schema binary wire protocol is version-locked, so a mismatch deserializes
silently wrong (fields arrive `undefined`), not with a clean error. The decorated
schema (`@type`) lives ONLY on the server; the client types remote players
structurally (`PlayerView`) to avoid the decorator tsconfig fighting the Vite build.
