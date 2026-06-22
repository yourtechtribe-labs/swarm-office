# F4 — Multi-agent NPCs: agents that talk to each other (and, soon, act)

> Status: **draft for approval** (specify phase; not implemented). Builds directly on
> F2 (one AI NPC wired to the M.IA gateway). Goal: ≥2 AI agents that **converse with
> each other**, iterate toward a goal, and decide when they're done — with a human in
> the loop — and then can **act via tools** (first tool: move). Date: 2026-06-22.
> Author: Albert + Claude. Read F2 (`docs/specs/F2-ai-npcs.md`) first.

## 1. Goal

Today one NPC answers humans. F4 makes the office a **multi-agent** space: a second
(then Nth) agent, where agents **hear and answer each other**, iterate on a seeded
topic until they reach a conclusion they decide on themselves, and surface that
decision. A human supervises (human-in-the-loop): seeds/addresses a topic, watches,
can interrupt or re-seed. Then agents gain **tools** (function-calling) so the gateway
drives not just speech but **action** — starting with moving around the office.

This is the foundation for the real intent: agents that **organize and work on a
project together**. v1 has no sandbox and no real tools beyond `move` — but it
establishes the interaction + action loop everything else will build on.

## 2. What this builds on (the seams already exist)

- **Client renders N NPCs for free.** `players.onAdd` already creates a labelled
  `RemotePlayer` per player and skips the `VoicePeer` for `isNpc` ones. A second NPC
  needs **zero** client changes to appear/move/be-labelled.
- **The gateway is already the brain** (`miaGateway.gatewayComplete`, OpenAI-compatible,
  verified incl. tool-calling). F4 reuses it; F4b adds a `tools` param.
- **The server already moves an NPC each tick** (`NpcController.update`) and logs to
  the UI panel (`server-log`). F4b's `move` tool just sets the target the tick walks to.

The ONE thing that does NOT exist yet — and is the heart of F4a — is a way for agents
to **take turns talking to each other and stop on their own**. That is the real work.

## 3. Scope

### F4a — second agent + NPC↔NPC conversation (chat only, NO tools)
- **N agents, generic-but-specializable.** Replace the single hard-coded NPC with a
  small roster where each agent is `{key, name, persona}` config. v1 ships 2 generic
  personas (same base prompt, distinct name/color); specializing later = editing
  config, no code (the architecture must not hard-code "two").
- **A `ConversationManager` owns NPC↔NPC turns** (see §4.2) — the spine of F4a.
- **Termination by the agents themselves**, via a PASS signal → pass-to-consensus
  (§4.3). No hard turn cap (per product decision: controlled env).
- **Human-in-the-loop**: a human message seeds/addresses the topic and can interrupt
  or re-seed mid-round (§4.4); humans always see every turn.
- **Human STOP control + runaway backstop + per-turn observability** (§4.5–4.6) — the
  safety that substitutes for the absent hard cap.

### F4b — tool-calling + the `move` tool
- A **tool registry** (extensible) passed to the gateway as `tools`; **single-step**
  execution (parse `tool_calls` → execute → done; NO multi-step ReAct loop in v1).
- **`move`**: the agent picks a destination (a zone, or "toward X") → the tool sets
  the NPC's target; the existing `update()` tick walks there (no pathfinding).
- `yield_turn`/PASS becomes a tool too (the F4a sentinel, formalized).

### Out / deferred (F4.x+)
- A real **sandbox + real tools** (the eventual "work on a project" substrate).
- Multi-step agent loops (ReAct), tool results fed back into a follow-up call.
- NPC voice (TTS/STT); pathfinding; persistence of conversations; >handful of agents
  at once (interest management is F3 territory).

## 4. Design

### 4.1 Agents as config (generic now, specializable later)
A `roster`: `[{ key:'npc:mia', name:'M.IA', persona:'…' }, { key:'npc:ada', name:'Ada', persona:'…' }]`.
Each is spawned exactly like today's NPC (`isNpc=true`, wander). The persona is the
ONLY thing that differs between agents; making it data (not code) is what lets a future
"specialize agent X as the critic" be a one-line config change. v1 personas are
generic ("a helpful teammate in the office") with just name/identity differences.

### 4.2 ConversationManager — serialize turns in ONE place (the spine)
**Why a manager, not "let NPCs hear the broadcast":** if NPC chat lines re-entered the
observe/broadcast path, we'd rebuild the exact self-loop F2 deliberately avoids, and
with ≥2 agents reacting concurrently we'd get **overlapping gateway calls and
out-of-order replies** (`replyPending` is per-NPC — useless across agents). So:

- `onMessage('chat')` stays **human-only** (unchanged). Humans never trigger NPC self-talk directly.
- A single `ConversationManager` owns a **round**. It runs **exactly one agent turn at
  a time** (one in-flight NPC gateway call, ever), round-robin across the agents in the
  conversation. This gives clean turn-taking, coherent ordering, bounded cost, and
  survives >2 agents (the team future) — all in one structure.
- It maintains ONE **shared transcript** of the round (not today's per-NPC history).
  Each agent's gateway call = shared transcript + that agent's persona as the system
  message. Each produced line is broadcast (via the existing `broadcastChatToZone`,
  stamped `from: agentKey`) AND appended to the shared transcript so the next agent
  sees it.

### 4.3 Termination — a turn is a LINE or a PASS; two passes = done
Two LLM agents told to "converse" never converge by default (politeness loop). So a
turn must be able to say **"nothing to add / I agree it's resolved"**:

- The agent turn yields a structured outcome: **`{ speak: boolean, message?: string }`**
  (F4a via structured output / a `[PASS]` sentinel; F4b via a `yield_turn` tool).
- `speak:false` = a **PASS**. **Two consecutive passes** end the round → that *is* "the
  agents decided they're done", and it terminates reliably without a hard cap.
- **A finished round PRODUCES a decision**, not silence: before the round closes, the
  last active speaker emits a concluding line stating the outcome ("Decidimos: …").
  The user said *decide*, not *chat* — the conclusion must surface or it reads as banter.

### 4.4 Trigger — human-in-the-loop, zero spend when idle
- A human message in the agents' zone **seeds/addresses** a topic → the manager starts a round.
- No human input → no round → **no LLM spend**. (This is *why* "no hard cap" is safe in
  a controlled env: idle is free; a round only runs because a human asked for one.)
- A human can **interrupt/re-seed** mid-round: a new human line is injected into the
  shared transcript and the round continues with that context (or restarts the goal).

### 4.5 Human STOP + runaway backstop (load-bearing safety, ships in F4a)
Since there's no turn cap, these REPLACE it:
- **Human STOP**: a UI control that halts the current round immediately (manager stops
  issuing turns; any in-flight reply is the last).
- **Runaway backstop**: a deliberately-high ceiling (e.g. 30 turns) that, if hit, stops
  the round and logs **loudly** as a WARNING — distinct from normal pass-termination,
  because hitting it means the PASS mechanism failed (a bug signal, not a feature).

### 4.6 Observability
Every NPC turn goes to the `server-log` panel with a **running turn counter + cumulative
round latency** (e.g. `🔁 turn 3 · Ada · 240ms · round Σ 0.9s`), so a runaway is
visible at a glance. Pass/consensus and STOP are logged distinctly.

### 4.7 F4b — tool registry + `move` (single-step)
- Extend the gateway call with `tools` (JSON-schema function defs). Parse
  `choices[0].message.tool_calls`; for each, look up a **tool registry**
  (`name → handler`) and execute server-side. **Single-step**: execute and finish the
  turn (no feeding the result back for another call in v1).
- **`move(target)`**: validate target (a known zone id, or "toward:<agentKey>"); set the
  NPC's `targetX/targetY` (and let `update()` walk there). Fire-and-forget; near-zero new
  movement code. Out of zone → the agent naturally leaves the conversation (zone-scoped).
- A turn may both `speak` and `move` (text + a tool call), or PASS, or just move.

### 4.8 Client impact (small)
- N NPCs already render. Add: a **STOP button** (emits a bus event → room → manager) and
  optionally a subtle "agent is thinking…" indicator during an in-flight turn. The
  `server-log` panel (F2) already exists to show the round.

## 5. Security / cost
- **No hard cap is safe here BECAUSE**: idle = zero spend (§4.4) + pass-to-consensus
  terminates rounds (§4.3) + human STOP + runaway backstop (§4.5). State this; it's the
  whole argument.
- **One in-flight NPC call at a time** (§4.2) bounds concurrent spend structurally.
- **Gateway + tools are server-side only**; the key never reaches the client (as F2).
- **Prompt-injection**: human seeds AND other agents' lines are untrusted input in the
  shared transcript; the persona prompt keeps each agent in role and refuses to leak it
  (as F2 §6). Tool args are validated server-side before execution (never eval'd).

## 6. Validation (deterministic, like F0–F2)
- **F4a**: seed a topic with 2 agents → observe alternating turns in the transcript
  (round-robin, never two in-flight at once); the round **terminates** on two passes and
  emits a decision line; STOP halts mid-round; the runaway backstop fires + logs loudly
  if PASS is disabled (negative test). Headless probe asserts turn ordering + that the
  round ends. Idle (no human input) → zero gateway calls.
- **F4b**: an agent emits a `move` tool call → its `target` updates and the avatar walks
  there; an invalid target is rejected (logged), not executed. **Pre-req**: eyeball one
  live gateway response to confirm `tool_calls` come back in the standard OpenAI shape on
  this vLLM build before depending on it.

## 7. Sequencing
F4a (conversation manager + pass-to-consensus + human STOP — all the multi-agent
plumbing, reuses the chat path) → verify gateway `tool_calls` shape → F4b (tools +
move). Build F4a first; it de-risks the loop, and F4b becomes a localized addition
(a `tools` param + a registry + one handler).

## 8. Open questions for /plan
- Where does the human STOP / seed UI live (a button near chat? a slash-command in chat
  like `/stop`, `/seed <topic>`?).
- Does a round have an explicit **goal object** (seeded text + "resolved?" check), or is
  the goal just the seed line in the transcript and consensus is purely the agents' call?
- Round-robin order + who speaks first after a human seed.
- Persona content for the 2 generic agents (names/colors/base prompt).
- F4b: the initial tool set beyond `move` (e.g. `yield_turn`, `look`/perceive?) — keep
  minimal for v1.
