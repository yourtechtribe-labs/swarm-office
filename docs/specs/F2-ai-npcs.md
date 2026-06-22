# F2 — AI agents as NPCs (M.IA / Predicta citizens of the office)

> Status: **draft for next session** (specify phase; not yet implemented). This is
> the differentiator of swarm-office vs WorkAdventure: AI agents are first-class
> office citizens, not bolted-on. Date: 2026-06-22. Author: Albert + Claude.
> Read this + `docs/SPEC.md` + the F0/F1 specs before implementing.

## 1. Goal

An **AI agent appears in the office as an NPC**: a player-like avatar that walks
around, has a name and a zone, and **talks in chat** — driven by an AI brain (the
M.IA gateway), not by a browser. A human in the same zone can chat with it and get
a real reply.

## 2. Why this is cheap to build (the seams already exist)

F0/F1 were built so this slots in:
- **An NPC is just another `state.players` entry** with no browser behind it →
  the client already renders it as a `RemotePlayer` via `players.onAdd` (zero
  client work to make it appear/move).
- **Zones already track membership server-side** (`player.zone`) → the server knows
  which humans share an NPC's zone (who it can talk to).
- **Zone-scoped chat (F1a)** already routes by zone → an NPC's reply, broadcast from
  its sessionId, reaches exactly the humans in its zone.
- The **one known gap is flagged in code**: `OfficeScene` would currently create a
  `VoicePeer` (WebRTC) for an NPC, which would never connect (dead PC). See the "F2
  NOTE" comment at the VoicePeer creation site — gate it on a human/NPC flag.

## 3. Scope

**In (F2 v1):**
- **F2a — NPC plumbing**: the server spawns an NPC entity (a `Player` with a
  synthetic key, `isNpc: true`), moves it (simple wander/scripted), and it can post
  chat lines into its zone. Proves the whole loop with NO external AI.
- **F2b — wire to the M.IA gateway**: the NPC's chat replies (and optionally its
  movement intent) come from the real AI agent. Human says X in the NPC's zone →
  server sends X + context to the M.IA gateway → reply broadcast as the NPC's line.

**Out / deferred:**
- **NPC voice** (TTS/STT over the F1 mesh) → F2.x. v1 NPCs are text-only; the
  human-only voice mesh stays unchanged (NPCs get NO VoicePeer).
- **Multiple NPCs / personas, pathfinding, persistence** → start with ONE NPC,
  wander movement, one persona.

## 4. Design

### 4.1 Schema
Add to `Player`: `@type('boolean') isNpc = false`. The client reads it (structural
`PlayerView` gains `isNpc: boolean`) to (a) **skip VoicePeer creation** for NPCs and
(b) render a visual marker (label/tint) so humans see it's an agent.

### 4.2 NPC lifecycle (server)
- A server-side **NpcController** creates one `Player` in `OfficeState.players`
  under a synthetic key (e.g. `npc:mia`), `isNpc=true`, name `"M.IA"`, spawned in a
  zone. It is NOT a Colyseus client/connection — just a state entry the server owns.
- Movement: a server tick moves the NPC (wander, or toward a target), updating its
  `x/y` and `zone` (reuse `zoneAt`). The existing patch loop broadcasts it; clients
  interpolate it like any RemotePlayer.
  - NOTE: this is the FIRST server-side mutation outside `onMessage('move')` — F2
    introduces a server simulation tick for NPCs only. Keep it minimal.

### 4.3 Chat with the NPC
- Humans chat is already zone-scoped. The NpcController **sees messages in the NPC's
  zone** (server-side it can inspect, since chat is server-relayed) and decides to
  reply.
- **F2a**: canned/scripted replies (prove the path).
- **F2b**: call the **M.IA gateway** with the message + context (who, which zone,
  recent lines) → get a reply → broadcast it as a chat line `from: npcKey`. The
  client renders it like any chat line (author = the NPC's name).

### 4.4 Client impact (small)
- Skip `new VoicePeer(...)` when `player.isNpc` (the flagged caveat).
- Visual marker for NPC avatars (a label, or alpha/no-alpha distinction — avoid
  Phaser 4 `setTint` breaking-change; use a Text label like the zone labels).

## 5. The M.IA gateway (the unknown to explore first in F2b)

`docs/SPEC.md` says "hook al gateway M.IA". **This is external and undocumented
here** — the next session's FIRST step for F2b is to **explore the gateway**: its
URL, auth, request/response shape, streaming or not, cost/latency. Treat it like the
Colyseus/WebRTC explores: verify the real API before designing against it. Until
that's known, F2a (scripted NPC) is fully buildable and de-risks all the plumbing.

## 6. Security / cost (LLM gotchas — A04/A05)

- **Gateway calls are server-side only** — the API key never reaches the client
  (same discipline as everything else; identity stays server-controlled).
- **Rate-limit NPC replies**: an LLM call costs money + latency. Reply to *complete
  messages*, debounce, and cap replies per minute. Do NOT call the gateway per
  keystroke or per frame.
- **Prompt-injection**: human chat text goes into the agent prompt → wrap user text
  in a clear delimiter and treat it as untrusted (the agent must not obey
  instructions embedded in chat).
- If the gateway is an Anthropic-backed agent, read the workspace `/claude-api`
  reference before wiring (model ids, caching, structured outputs).

## 7. Validation (deterministic, like F0/F1)

- F2a: NPC entry exists in `state.players` with `isNpc:true`; a browser tab renders
  it as an avatar that moves; **no VoicePeer is created for it** (assert
  `scene.peers` has no entry for the NPC key); a human chat in its zone yields an
  NPC chat line; a chat in a DIFFERENT zone does not.
- F2b: a human message produces a gateway-derived reply within a sane latency; rate
  limit holds (N messages → ≤ M gateway calls).

## 8. Sequencing
F2a (scripted NPC — all the plumbing, zero external deps) → explore M.IA gateway →
F2b (real AI). Build F2a first; it makes F2b a localized swap of the reply source.

## 9. Open questions for /plan (next session)
- M.IA gateway: URL / auth / API shape (explore first).
- NPC movement model: pure wander vs agent-directed targets.
- Reply trigger: every in-zone human message, or only when addressed (e.g. name
  mention)? (Cost vs liveliness.)
- One NPC vs a small fleet; persona/config source.
