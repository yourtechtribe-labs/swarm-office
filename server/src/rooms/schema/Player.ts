import { Schema, type } from '@colyseus/schema';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  Player — one synchronized avatar in the office state
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT A Schema IS, UNDER THE HOOD
 * --------------------------------
 * A Colyseus Schema is not a plain object — it's an instrumented class whose
 * fields are tracked for CHANGES. The `@type(...)` decorator registers each field
 * with the serializer so Colyseus can:
 *   1. Encode the state to a compact BINARY buffer (not JSON) — a number is a few
 *      bytes, not "x":123.
 *   2. Send only DELTAS: when `player.x` changes, only that field (with its field
 *      index) goes on the wire, not the whole state. This is why Colyseus scales —
 *      moving one player broadcasts a handful of bytes, not the full room.
 *
 * THE DECORATOR GOTCHA (why the server has its own tsconfig)
 * ---------------------------------------------------------
 * `@type` is a *legacy* property decorator. It needs `experimentalDecorators:true`
 * and `useDefineForClassFields:false` (see server/tsconfig.json). Modern class-field
 * semantics would overwrite the value the decorator needs to observe. This is the
 * reason this decorated class lives ONLY on the server and is NEVER imported into
 * the client's Vite build — the client types remote players structurally instead.
 *
 * The field initializers (= 0, = '') matter: Colyseus uses them as defaults when a
 * Player is created, and a Schema field must have a concrete initial value.
 */
export class Player extends Schema {
  /** World position X (pixels). Authored by the owning client, relayed by us. */
  @type('number') x = 0;
  /** World position Y (pixels). */
  @type('number') y = 0;
  /** Display name (empty until the chat/name slice; reserved now). */
  @type('string') name = '';
  /**
   * Id of the zone the player is currently inside ('' = none). Computed by the
   * SERVER from (x,y) on join and on every move, so it's part of the shared state
   * every client sees — the foundation for F1 proximity grouping.
   */
  @type('string') zone = '';
  /**
   * Is this avatar an AI NPC (no browser behind it) rather than a human? (F2)
   *
   * WHY THIS LIVES IN THE SYNCED SCHEMA (not server-only state)
   * ----------------------------------------------------------
   * An NPC is, deliberately, *just another Player entry* — the client already
   * spawns/moves it via `players.onAdd`/`onChange` with zero new code (the "player
   * seam"). But two client behaviours must differ for an NPC, so the client has to
   * KNOW it's an NPC — hence this flag rides the same delta-sync as x/y/zone:
   *   1. SKIP the WebRTC VoicePeer: there is no peer to connect to (a dead
   *      PeerConnection that would never negotiate). The voice mesh stays human-only.
   *   2. RENDER a marker (a name label) so a human reads it as an agent, not a player.
   * Defaults false, so every human (who never sets it) is correctly a non-NPC; only
   * the server-spawned NPC flips it true.
   */
  @type('boolean') isNpc = false;
}
