import os from 'node:os';
import path from 'node:path';
import { Room, type Client } from 'colyseus';
import { OfficeState } from './schema/OfficeState';
import { Player } from './schema/Player';
import { ZONES, zoneAt } from './zones';
import { NpcController } from './NpcController';
import { ConversationManager } from './ConversationManager';
import { makeWorkClient } from './workClient';
import { makeWorkspaceClient } from './workspaceClient';
import { ROSTER } from '../agents/roster';

/** Spawn point — matches the client world centre (WORLD_W/2, WORLD_H/2). */
const SPAWN_X = 800;
const SPAWN_Y = 600;

type MovePayload = { x: number; y: number };
type JoinOptions = { name?: string };

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  OfficeRoom — one running instance of the office
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A Room is a server-side container for a group of clients sharing one OfficeState.
 * Colyseus calls the lifecycle hooks below for us:
 *   onCreate() → once, when the room instance is first created.
 *   onJoin()   → each time a client is accepted into the room.
 *   onLeave()  → each time a client disconnects.
 *   onMessage()→ registered handlers fire when a client sends that message type.
 *
 * THE SERVER TICK (what happens "for free", and the one exception)
 * ----------------------------------------------------------------
 * For HUMANS this is a pure relay: we mutate state only in response to "move"
 * messages (relay model — see OfficeState). Colyseus runs its own patch loop
 * (~20 Hz by default): every tick it diffs the state, encodes the binary deltas,
 * and broadcasts them to all clients. That's the third "clock" of the system; our
 * job is just to keep OfficeState correct.
 *
 * THE ONE EXCEPTION (F2): an AI NPC has no client sending "move", so we add a
 * single server-driven simulation tick (`setSimulationInterval` below) that lets
 * the NpcController advance the NPC's position. It is the only state we mutate
 * without a client message; humans stay pure relay. See NpcController for the why.
 */
// Colyseus 0.17 typed Room: the generic is a bag of { state, metadata, client },
// not the bare state type (that was the pre-0.17 form). We only need `state`.
export class OfficeRoom extends Room<{ state: OfficeState }> {
  /** The AI agents' BODIES, keyed by agent key (`npc:seneca`, …). One per roster entry
   *  (F4a generalizes F2's single NPC). The ConversationManager looks bodies up here. */
  private npcs = new Map<string, NpcController>();
  /** The agents' shared MIND: owns NPC↔NPC rounds (turn-taking, consensus, STOP). */
  private conversation!: ConversationManager;

  onCreate() {
    // Install the authoritative state replica for this room.
    this.state = new OfficeState();

    // F4a — spawn the AI agents as citizens of this room from the DATA roster. Each is
    // a normal Player entry (isNpc=true) an NpcController owns; clients render them via
    // the same player seam as any human remote. Spawned before any human joins so they
    // are already present. Pass our serverLog so their events surface both in the
    // terminal AND the in-browser log panel (bound here so controllers stay Colyseus-
    // agnostic). All v1 agents share a home zone so they can actually hear each other.
    for (const agent of ROSTER) {
      const body = new NpcController(this.state, agent, (level, text) => this.serverLog(level, text));
      body.spawn();
      this.npcs.set(agent.key, body);
    }

    // The MIND. It serializes a round (one agent turn at a time, ONE in-flight gateway
    // call ever) over a shared transcript, and reaches humans via the SAME zone-scoped
    // delivery as chat. It only reads key + currentZone from each body (the AgentBody
    // contract), so it never touches Colyseus directly.
    // F5 — if a harness work service is configured (HARNESS_URL), agents can DO real work
    // (the `do_work` tool delegates to a sandboxed ReAct loop). Without it, do_work degrades
    // to a chat line and the office still runs (R6). The model + per-zone workspace are env.
    const harnessUrl = process.env.HARNESS_URL?.trim();
    // ABSOLUTE root (not the literal '/tmp/...'): on Windows `/tmp` is drive-relative, so
    // Path('/tmp/...').resolve() lands on C:\tmp or G:\tmp depending on the daemon's launch
    // cwd — while the agents' files ended up under %TEMP%. Office and harness then browsed
    // DIFFERENT physical dirs → "workspace vacío". os.tmpdir() is the same stable absolute
    // path on both (\%TEMP%\ on Windows, /tmp on Linux), so they always agree.
    const workWsRoot = process.env.WORK_WS_ROOT?.trim() || path.join(os.tmpdir(), 'office-ws');
    // One place maps a zone to its workspace dir — used both to RUN work (below) and to
    // BROWSE it (F6 proxy handlers). Keeping it single-source avoids the two drifting.
    const zoneWorkspace = (zone: string) => path.join(workWsRoot, zone || 'lobby');
    // F6 — read-only browsing of that same per-zone workspace, proxied to the harness.
    const wsClient = harnessUrl ? makeWorkspaceClient(harnessUrl) : undefined;

    this.conversation = new ConversationManager({
      roster: ROSTER,
      bodies: this.npcs,
      broadcastChat: (zone, from, text) => this.broadcastChatToZone(zone, from, text),
      log: (level, text) => this.serverLog(level, text),
      turnDelayMs: 700, // a readable pace between turns (the probe uses 0)
      // RUNAWAY_CAP env: a turn ceiling (safety net). Set RUNAWAY_CAP=0 for UNLIMITED —
      // the round then ends only on consensus or a human /stop. Unset → default 30.
      runawayCap: process.env.RUNAWAY_CAP !== undefined ? Number(process.env.RUNAWAY_CAP) : undefined,
      // The real safety behind unlimited turns: stop a degenerate (no-progress) loop.
      noProgressCap: process.env.NO_PROGRESS_CAP !== undefined ? Number(process.env.NO_PROGRESS_CAP) : undefined,
      workClient: harnessUrl ? makeWorkClient(harnessUrl) : undefined,
      workModel: process.env.WORK_MODEL?.trim() || '',
      zoneWorkspace,
      // F6 — a work turn just changed files on disk; tell every client to refresh its tree.
      onWorkspaceChanged: (zone) => this.broadcast('ws-changed', { zone }),
    });

    // The ONE server simulation tick (see NpcController's class comment): drive every
    // agent's wander. Colyseus calls this every ~100 ms with the elapsed milliseconds;
    // we hand each controller seconds (dt/1000) so its speed maths is in px/second.
    // 100 ms (10 Hz) is plenty for a calm wander — the ~20 Hz patch loop broadcasts the
    // changes and clients interpolate between them, so the agents look smooth.
    this.setSimulationInterval((deltaMs) => {
      const dt = deltaMs / 1000;
      for (const body of this.npcs.values()) body.update(dt);
    }, 100);

    // CLIENT → SERVER: a client reports its own avatar's new position. We trust
    // it (relay model) and write it into state; the patch loop broadcasts the
    // delta to everyone else. We look the player up by sessionId — the client
    // can only ever move its own avatar, never someone else's.
    this.onMessage('move', (client, data: MovePayload) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return; // message arrived before/after the player existed
      player.x = data.x;
      player.y = data.y;
      // Derive zone membership from the new position and sync it (delta-broadcast).
      player.zone = zoneAt(data.x, data.y);
    });

    // CHAT: a TRANSIENT message, not state. Unlike positions (continuous "current
    // truth" → schema sync), a chat line is an event that happened once → we send it
    // to the right recipients and forget. So it lives in messages, not OfficeState;
    // the trade-off is that late joiners don't see prior lines (history/persistence
    // is deferred — would need a ring buffer in state or a DB).
    this.onMessage('chat', async (client, data: { text?: unknown }) => {
      // Validate on the SERVER — this is the security boundary (OWASP A03), not the
      // client. Coerce-check the type first so a malformed payload can't throw on
      // the string methods; trim before the empty-check; cap length server-side
      // regardless of any client cap (client cap is UX, this one is the rule).
      if (typeof data?.text !== 'string') return;
      const text = data.text.trim();
      if (!text) return;
      const capped = text.slice(0, 500);
      // `from` is the server-controlled sessionId — never a client-settable name
      // (anti-spoof). player.zone is computed authoritatively on join + every move.
      const sender = this.state.players.get(client.sessionId);
      const senderZone = sender?.zone ?? '';
      this.broadcastChatToZone(senderZone, client.sessionId, capped);
      // F4a — chat stays HUMAN-ONLY (spec §4.2). A plain human line no longer triggers
      // an NPC reply: the agents converse only when a human SEEDS a topic via the
      // separate `agent-cmd` channel below. Keeping NPC turns off this path is what
      // structurally prevents an NPC line from re-entering here (no reply loop).
    });

    // F4a — the SEED/STOP command channel (the slash-commands /seed, /stop parsed
    // client-side and relayed here as a dedicated message, so they never render as a
    // chat line nor touch the human chat path). This is the human-in-the-loop control:
    // a seed starts/re-seeds a round in the human's zone; a stop halts it. Validated
    // server-side like every other input (the security boundary is here, not the client).
    this.onMessage('agent-cmd', (client, data: { kind?: unknown; topic?: unknown }) => {
      if (data?.kind === 'stop') {
        this.conversation.stop();
        return;
      }
      if (data?.kind === 'seed' && typeof data.topic === 'string') {
        const topic = data.topic.trim().slice(0, 500);
        if (!topic) return;
        const sender = this.state.players.get(client.sessionId);
        // Seed in the human's OWN zone, stamped from their sessionId (so the echoed
        // seed shows as "you" on their client). The manager only starts a round if ≥2
        // agents share that zone.
        this.conversation.seed(sender?.zone ?? '', topic, client.sessionId, sender?.name ?? '');
      }
    });

    // VOICE SIGNALING RELAY (F1b): WebRTC needs a side channel to exchange SDP
    // offers/answers + ICE candidates between two specific peers before media can
    // flow directly. We reuse this room's WebSocket as that channel. The server is
    // a DUMB RELAY — it forwards the opaque blob to the addressed peer and never
    // inspects the media payload (the audio itself never touches the server; it's
    // peer-to-peer). `from` is stamped server-side from the connection's sessionId
    // so a client cannot forge who a signal came from (same anti-spoof discipline
    // as chat). No media server, no token: identity is the sessionId we control.
    this.onMessage('signal', (client, data: { to?: unknown; data?: unknown }) => {
      if (typeof data?.to !== 'string') return;
      // getById is Colyseus's built-in sessionId → Client lookup over the client
      // list (same O(n) scan we'd write by hand, but it's the framework's named API).
      const target = this.clients.getById(data.to);
      target?.send('signal', { from: client.sessionId, data: data.data });
    });

    // F6 — WORKSPACE EXPLORER proxy. The browser asks for the listing / a file's content;
    // the office forwards to the harness (single trust boundary; the browser never reaches
    // it). The zone is the requesting player's AUTHORITATIVE zone (server state), never a
    // client-supplied one — so a client can only browse the workspace of where it actually
    // is. Read-only: there is no ws-write/ws-delete. Errors flow back as `{ error }`.
    this.onMessage('ws-list', async (client) => {
      const zone = this.state.players.get(client.sessionId)?.zone ?? 'lobby';
      const res = wsClient ? await wsClient.list(zoneWorkspace(zone)) : { error: 'sin harness configurado' };
      client.send('ws-files', res);
    });
    this.onMessage('ws-read', async (client, data: { path?: unknown }) => {
      if (typeof data?.path !== 'string') return; // validate on the server (security boundary)
      const zone = this.state.players.get(client.sessionId)?.zone ?? 'lobby';
      const res = wsClient ? await wsClient.read(zoneWorkspace(zone), data.path) : { error: 'sin harness configurado' };
      client.send('ws-file', res);
    });
  }

  /**
   * Emit a server event to BOTH the terminal (console) AND every connected client
   * (a `server-log` broadcast → the in-browser log panel). One sink so operator
   * visibility is identical in the terminal and the UI. Transient like chat — late
   * joiners don't see prior lines (no history kept server-side). It carries no
   * secrets (NPC status, presence) — safe to fan out to all clients in this app.
   */
  private serverLog(level: 'info' | 'warn' | 'error', text: string) {
    if (level === 'warn') console.warn(text);
    else if (level === 'error') console.error(text);
    else console.log(text);
    this.broadcast('server-log', { level, text });
  }

  /**
   * Deliver a chat line to everyone in `zone`, stamped `from` (a sessionId or the
   * NPC key). Extracted (F2a) so the human path and the NPC's own replies share ONE
   * delivery rule — an NPC has no WebSocket, so it cannot reuse the client's
   * onMessage path; this is how its line reaches the right humans.
   *
   * ZONE-SCOPED delivery (F1a): send only to clients in the SAME zone — the no-zone
   * hub ('') is its own group (`'' === ''`). A human sender always matches its own
   * zone, so it still receives its own line (single receive→render path; the client
   * marks its own lines by comparing `from` to its sessionId). `from` is always
   * server-controlled (a sessionId or NPC_KEY), never a client-settable name
   * (anti-spoof). NB: recipients are `this.clients` (real connections) — the NPC is
   * not a client, so it never needs to "receive" anything.
   */
  private broadcastChatToZone(zone: string, from: string, text: string) {
    for (const c of this.clients) {
      const recipientZone = this.state.players.get(c.sessionId)?.zone ?? '';
      if (recipientZone === zone) {
        c.send('chat', { from, text });
      }
    }
  }

  // A new connection was accepted. Create its avatar at the spawn point and add it
  // to the map → Colyseus emits an "onAdd" to every client (spawn the remote).
  onJoin(client: Client, options: JoinOptions) {
    const player = new Player();
    player.x = SPAWN_X;
    player.y = SPAWN_Y;
    player.name = options?.name ?? '';
    // Compute the spawn zone now (not only on move) — a player who joins inside a
    // zone and never moves must still report it. The spawn is inside "lobby".
    player.zone = zoneAt(SPAWN_X, SPAWN_Y);
    this.state.players.set(client.sessionId, player);

    // Push the static zone geometry to this client so it can draw the areas. We
    // send it here on join (single source of truth on the server). The client
    // registers its "zones" handler synchronously on join, so it's ready before
    // this message arrives over the wire.
    client.send('zones', ZONES);

    this.serverLog('info', `➕ ${client.sessionId.slice(0, 6)} entró (${this.clients.length} presentes)`);
  }

  // A connection dropped. Remove its avatar → Colyseus emits "onRemove" to every
  // client (despawn the remote).
  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.serverLog('info', `➖ ${client.sessionId.slice(0, 6)} salió (${this.clients.length} presentes)`);
  }
}
