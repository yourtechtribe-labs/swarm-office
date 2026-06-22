import { Room, type Client } from 'colyseus';
import { OfficeState } from './schema/OfficeState';
import { Player } from './schema/Player';
import { ZONES, zoneAt } from './zones';
import { NpcController, NPC_KEY } from './NpcController';

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
  /** Owns the AI NPC entry + its server-side wander (F2). One per room instance. */
  private npc!: NpcController;

  onCreate() {
    // Install the authoritative state replica for this room.
    this.state = new OfficeState();

    // F2a — spawn the AI NPC as a citizen of this room. It's a normal Player entry
    // (isNpc=true) the NpcController owns; clients render it via the same player seam
    // as any human remote. Spawned before any human joins so it's already present.
    this.npc = new NpcController(this.state);
    this.npc.spawn();

    // The ONE server simulation tick (see the class comment): drive the NPC's wander.
    // Colyseus calls this every ~100 ms with the elapsed milliseconds; we hand the
    // controller seconds (dt/1000) so its speed maths is in px/second. 100 ms (10 Hz)
    // is plenty for a calm wander — the ~20 Hz patch loop broadcasts the changes and
    // clients interpolate between them, so the NPC looks smooth at render rate.
    this.setSimulationInterval((deltaMs) => this.npc.update(deltaMs / 1000), 100);

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
    this.onMessage('chat', (client, data: { text?: unknown }) => {
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
      const senderZone = this.state.players.get(client.sessionId)?.zone ?? '';
      this.broadcastChatToZone(senderZone, client.sessionId, capped);

      // F2a — let the NPC HEAR this in-zone human line and maybe reply. Done here,
      // AFTER delivering the human line and ONLY inside onMessage: the NPC's reply
      // is sent via broadcastChatToZone (below), never through onMessage, so it
      // cannot re-enter observeChat → no reply loop (the guarantee is structural,
      // not a flag). The reply is stamped from: NPC_KEY and scoped to the NPC's zone
      // (== senderZone whenever it replies, since it only hears its own zone).
      const reply = this.npc.observeChat(client.sessionId, senderZone, capped);
      if (reply) this.broadcastChatToZone(this.npc.currentZone, NPC_KEY, reply);
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

    console.log(`[office] + ${client.sessionId} joined (${this.clients.length} present)`);
  }

  // A connection dropped. Remove its avatar → Colyseus emits "onRemove" to every
  // client (despawn the remote).
  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    console.log(`[office] - ${client.sessionId} left (${this.clients.length} present)`);
  }
}
