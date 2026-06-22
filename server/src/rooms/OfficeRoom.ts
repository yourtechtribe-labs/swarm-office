import { Room, type Client } from 'colyseus';
import { OfficeState } from './schema/OfficeState';
import { Player } from './schema/Player';
import { ZONES, zoneAt } from './zones';

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
 * THE SERVER TICK (what happens "for free")
 * -----------------------------------------
 * We do NOT run a simulation loop here (relay model — see OfficeState). We only
 * mutate state in response to "move" messages. Colyseus runs its own patch loop
 * (~20 Hz by default): every tick it diffs the state, encodes the binary deltas,
 * and broadcasts them to all clients. That's the third "clock" of the system; our
 * job is just to keep OfficeState correct.
 */
// Colyseus 0.17 typed Room: the generic is a bag of { state, metadata, client },
// not the bare state type (that was the pre-0.17 form). We only need `state`.
export class OfficeRoom extends Room<{ state: OfficeState }> {
  onCreate() {
    // Install the authoritative state replica for this room.
    this.state = new OfficeState();

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
    // truth" → schema sync), a chat line is an event that happened once → we
    // broadcast it and forget. So it lives in messages, not OfficeState; the
    // trade-off is that late joiners don't see prior lines (history/persistence is
    // deferred — would need a ring buffer in state or a DB).
    this.onMessage('chat', (client, data: { text?: unknown }) => {
      // Validate on the SERVER — this is the security boundary (OWASP A03), not the
      // client. Coerce-check the type first so a malformed payload can't throw on
      // the string methods; trim before the empty-check; cap length server-side
      // regardless of any client cap (client cap is UX, this one is the rule).
      if (typeof data?.text !== 'string') return;
      const text = data.text.trim();
      if (!text) return;
      const capped = text.slice(0, 500);
      // Broadcast to everyone present INCLUDING the sender, so a single code path
      // (receive → render) builds the message list; the client marks its own lines
      // by comparing `from` to its sessionId. `from` is the sessionId (identity we
      // control), never a client-settable name (which would be a spoofing vector).
      this.broadcast('chat', { from: client.sessionId, text: capped });
    });
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
