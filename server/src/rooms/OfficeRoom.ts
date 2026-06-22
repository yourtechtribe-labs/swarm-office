import { Room, type Client } from 'colyseus';
import { OfficeState } from './schema/OfficeState';
import { Player } from './schema/Player';

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
    });
  }

  // A new connection was accepted. Create its avatar at the spawn point and add it
  // to the map → Colyseus emits an "onAdd" to every client (spawn the remote).
  onJoin(client: Client, options: JoinOptions) {
    const player = new Player();
    player.x = SPAWN_X;
    player.y = SPAWN_Y;
    player.name = options?.name ?? '';
    this.state.players.set(client.sessionId, player);
    console.log(`[office] + ${client.sessionId} joined (${this.clients.length} present)`);
  }

  // A connection dropped. Remove its avatar → Colyseus emits "onRemove" to every
  // client (despawn the remote).
  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    console.log(`[office] - ${client.sessionId} left (${this.clients.length} present)`);
  }
}
