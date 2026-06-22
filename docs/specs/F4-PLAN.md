# F4 — Implementation PLAN (multi-agent NPCs)

> Plan for `docs/specs/F4-multi-agent-npcs.md`. Phase: **plan (design, not implemented)**.
> Date: 2026-06-22. Author: Albert + Claude. Complexity: **Medium, cross-layer**.
> Read the spec first; this plan only adds the *how* (files, interfaces, order, decisions).
>
> HARD RULE (repo CLAUDE.md): didactic/teaching comments are a first-class deliverable.
> Every new file below ships with `═══` block headers + WHY/UNDER-THE-HOOD comments;
> the `NpcController` refactor preserves all kept comments verbatim and only rewrites the
> ones whose code actually changes.

## 0. Decisions locked (resolves spec §8)

| §8 question | Decision | Rationale |
|---|---|---|
| STOP / seed UI | **Slash-commands in chat**: `/seed <topic>`, `/stop`. No new UI. | Reuses F0 chat input; matches spec's "emits a bus event → room → manager". |
| Implicit vs explicit seed | **Explicit `/seed` only.** A plain human chat line does NOT start a round. | Maximizes "zero spend when idle"; no accidental rounds; clearer UX. Refines §4.4. |
| Goal model | **Seed line in the shared transcript; consensus = the agents' call (double PASS). No `goal object`, no `resolved?` check.** | One source of truth for "done" (the PASS), avoids a 2nd terminating judge + its cost. Decision still surfaces via the §4.3 conclusion line. Migration path open for the "work on a project" future. |
| Tools v1 (F4b) | **`move` + `yield_turn` only.** | Minimal per §4.7/§8. `yield_turn` formalizes the F4a `[PASS]` sentinel as a tool. |
| Personas | **Roster of 2: `npc:seneca` ("Seneca") + `npc:marcus` ("Marcus")** (Roman stoics). Replace the hard-coded `npc:mia`. | Spec §3-F4a "replace the single hard-coded NPC with a roster". Same base persona, distinct name/color. |
| Round-robin / who first | **Roster order; first entry (Seneca) speaks first after a seed.** Deterministic. | Validation-friendly (headless probe asserts ordering). |

## 1. Architecture — split "body" from "mind"

Today `NpcController` owns BOTH the avatar's wander AND the F2 reply logic. F4 splits them:

- **`NpcController` = the body (per agent).** spawn + wander + one movable target. One
  instance per roster entry. F4b's `move` tool just calls `setMoveTarget()` on it.
- **`ConversationManager` = the mind (one, shared).** Owns a round: round-robin turns,
  ONE in-flight gateway call ever, the shared transcript, pass-to-consensus, STOP,
  runaway backstop, per-turn observability. This is the spine (spec §4.2) and the real work.

`onMessage('chat')` stays human-only and *loses* its `observeChat` call. Seeding/stopping
arrive on a **separate channel** (`agent-cmd`) so slash-commands never render as chat lines
and the F2 structural guarantee (NPC lines never re-enter `onMessage`) is preserved.

## 2. Files

### NEW

| File | Responsibility |
|---|---|
| `server/src/agents/roster.ts` | `AgentConfig = {key,name,persona,homeZone,color}` + `ROSTER` (Seneca, Marcus) + a `buildPersona(name)` helper (shared base prompt + per-agent identity + prompt-injection guard, ported from the old `SYSTEM_PROMPT`). |
| `server/src/rooms/ConversationManager.ts` | The round spine: `seed(zone, topic)`, `stop()`, the async turn loop, shared transcript, `[PASS]` detection + double-pass consensus, conclusion line, runaway backstop, turn/latency logging. |
| `server/src/rooms/tools.ts` *(F4b)* | Tool JSON-schema defs + registry `{ name → handler }`; handlers for `move(target)` and `yield_turn()`. Single-step, server-side, args validated (never eval'd). |

### MODIFIED

| File | Change | Increment |
|---|---|---|
| `server/src/rooms/NpcController.ts` | Parametrize by `AgentConfig` (key/name/persona/home/color). **Remove** `observeChat`, `history`, `replyPending`, reply gates. **Relocate** `scriptedReply` + the persona text to the manager/roster (do NOT delete — see §3a). **Keep** spawn/update/pickNewTarget/target. **Add** `setMoveTarget(x,y)` / `moveToZone(zoneId)` for F4b. Preserve all movement comments. | F4a |
| `server/src/rooms/OfficeRoom.ts` | Spawn **N** `NpcController`s from `ROSTER`; create one `ConversationManager`; tick updates all bodies; **remove** the `observeChat` call in `onMessage('chat')`; add `onMessage('agent-cmd')` → `manager.seed/stop`. | F4a |
| `server/src/rooms/schema/Player.ts` | Add `@type('string') color = ''` (per-agent label tint). One additive schema field. | F4a |
| `server/src/rooms/miaGateway.ts` | Add optional `tools` param; parse `choices[0].message.tool_calls`; widen return to `{ content: string|null; toolCalls?: ToolCall[] }` (new overload, F2-string path untouched for the manager's F4a text turns). | **F4b** |
| `client/src/game/EventBus.ts` | Add `'agent-command': (cmd: {kind:'seed';topic:string} \| {kind:'stop'}) => void`. (Optional, deferred: `'agent-thinking'`.) | F4a |
| `client/src/Chat.tsx` | In `send()`, parse a leading `/seed `/`/stop` → emit `'agent-command'` instead of `'chat-send'` (slash-commands never become chat lines). | F4a |
| `client/src/game/scenes/OfficeScene.ts` | Relay `'agent-command'` → `room.send('agent-cmd', …)`. (`server-log` relay already exists for observability.) | F4a |
| `client/src/net/room.ts` + `client/src/game/RemotePlayer.ts` | `PlayerView` reads `color`; label tint uses it (fallback to current yellow). | F4a (polish) |

## 3. Key interfaces

```ts
// roster.ts
export type AgentConfig = { key: string; name: string; persona: string; homeZone: string; color: string };
export const ROSTER: AgentConfig[]; // [Seneca, Marcus]

// ConversationManager.ts
export class ConversationManager {
  constructor(
    bodies: Map<string, NpcController>,        // agentKey → body (for move + zone)
    roster: AgentConfig[],
    broadcastChat: (zone: string, from: string, text: string) => void,
    log: (level: 'info'|'warn'|'error', text: string) => void,
  );
  seed(zone: string, topic: string): void;     // start a round if idle, else re-seed (inject into transcript)
  stop(): void;                                 // halt: loop stops issuing turns; in-flight reply is the last
  // private: runRound() async loop — one in-flight gateway call ever, round-robin,
  //   [PASS] detection, 2-pass consensus → conclusion line, runaway cap (e.g. 30) → WARN.
}
```

- **Per turn** the gateway sees `[{role:'system', content: persona}, ...sharedTranscript]`.
  Each produced line is broadcast via `broadcastChatToZone` stamped `from: agentKey` AND
  appended to the shared transcript so the next agent sees it (spec §4.2).
- **PASS** = the model signals it has nothing to add. Detection is **tolerant**: a turn is a
  PASS if its text contains the `[PASS]` token (Qwen may wrap it, e.g. "de acuerdo, [PASS]");
  the token is stripped from anything broadcast. Two consecutive passes → consensus → one
  final **conclusion turn to the last NON-pass speaker** ("responde en una línea empezando
  por 'Decidimos:'") → broadcast → close + log. (F4b: `yield_turn` tool replaces the sentinel.)
- **Idle = no loop running = zero gateway spend.** A round only exists because `/seed` ran.

### 3a. Scripted fallback lives in the manager (load-bearing — do not delete)

The F2 `scriptedReply` is **relocated**, not removed: it's the off-VPN runtime path AND the
seam that makes §6 validation deterministic.

- **Runtime**: when `gatewayConfigured()` is false (e.g. a dev off the UAB VPN), the manager
  routes each turn through a **roster-driven scripted responder** (a per-agent canned line +
  a deterministic PASS after K turns) so a `/seed` round still runs and terminates out-of-the-box.
- **Validation test-mode**: a manager flag can **force PASS** (assert "two passes → round ends
  + conclusion line") and **force never-PASS** (negative test: assert the runaway backstop
  fires + logs loudly). The headless probe runs entirely on this path — no VPN, fully
  deterministic, exactly like F0–F2.

### 3b. Zone ↔ participant binding (v1)

`broadcastChatToZone` only reaches co-zoned clients, so participants and the seed must share a
zone or the demo never fires. **v1 pins**: both roster agents have `homeZone = 'lobby'` (where
humans spawn); `seed(zone, topic)` builds the participant set = roster agents whose
`currentZone === seedZone`. If <2 agents are in the seed zone, the manager logs and no round
starts (no silent no-op).

### 3c. Seed echoes to chat

Slash-commands don't render as chat lines by themselves, so on `/seed <topic>` the manager
**echoes the seed into the zone** (via `broadcastChatToZone`, stamped from the human's name)
AND makes it the first `user` line of the shared transcript — so humans see what they seeded
and the agents' first turn has the topic as context.

## 4. Implementation order

**F4a** (de-risks the loop):
1. `roster.ts` (no deps).
2. `Player.ts` `color` field (+ client `PlayerView`/`RemotePlayer` tint) — additive, do early or last.
3. `NpcController` refactor → per-agent body.
4. `ConversationManager` → the round spine.
5. `OfficeRoom` wiring (spawn roster, manager, `agent-cmd`, drop `observeChat`).
6. Client: EventBus `agent-command` + `Chat.tsx` slash parse + `OfficeScene` relay.
7. **Validate F4a** (§6 below).

**Gate**: eyeball ONE live gateway response to confirm `tool_calls` come back in standard
OpenAI shape on this vLLM build (spec §6 pre-req) — needs UAB VPN.

**F4b** (localized addition):
8. `miaGateway` `tools` param + `tool_calls` parse.
9. `tools.ts` registry (`move`, `yield_turn`).
10. `ConversationManager`: pass tools, single-step execute, `yield_turn` → PASS.
11. **Validate F4b**.

## 5. Validation (deterministic, like F0–F2)

- **F4a**: `/seed` a topic with 2 agents → alternating turns in the transcript (round-robin,
  never two in-flight); round **terminates** on two `[PASS]` and emits a `Decidimos:` line;
  `/stop` halts mid-round; runaway backstop fires + logs **loudly** if PASS is disabled
  (negative test). Headless probe runs on the **scripted path** (§3a) — no VPN, deterministic:
  asserts turn ordering + that the round ends. **Idle (no `/seed`) → zero gateway calls.**
- **F4b**: an agent emits a `move` tool call → its `target` updates + the avatar walks; an
  invalid target is rejected (logged), not executed. Gateway `tool_calls` shape verified first.
- Dev gotcha (CLAUDE.md): on `EADDRINUSE :2567` the old listener is still serving stale code
  — kill :2567 and restart, don't trust the "Restarting…" log.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Removing `observeChat` changes F2 feel (no reply to plain human chat) | **Deliberate** + declared here; `/seed` is the new human→agents channel. Validate the seeded flow replaces it acceptably. |
| `color` schema field — networking version lock | Additive field, same colyseus 0.17.x line on both sides; client reads it structurally in `PlayerView`. Low risk. |
| Async turn loop overlap / STOP & re-seed races | One `running` guard; loop checks a `stopped` flag between turns; `/seed` mid-round injects into transcript, never starts a 2nd loop. ONE in-flight call by construction. |
| vLLM `tool_calls` support unverified | F4b is gated behind the §6 verification; if unsupported, fall back to sentinel-based PASS + a text-command for move (contingency, not v1 default). |
| Cost runaway | Bounded structurally: idle=0 + one-in-flight + double-PASS + runaway cap(30)→WARN + `/stop`. |
| Didactic comments dropped in refactor | Targeted `Edit`s over rewrites; carry kept comments verbatim; new files fully documented. |

## 7. Out of scope (per spec §3)

Real sandbox + real tools, multi-step ReAct loops, NPC voice, pathfinding, conversation
persistence, >handful of agents, the optional "thinking…" indicator (deferred; STOP is the
load-bearing control that ships).
