import { Schema, type, MapSchema } from '@colyseus/schema';
import { Player } from './Player';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  OfficeState — the authoritative shared state of one office room
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is the single source of truth the server owns and broadcasts. Every client
 * connected to the room receives a synchronized replica of it (and only the deltas
 * as it changes).
 *
 * WHY A MapSchema (not a plain object or array)
 * ---------------------------------------------
 * MapSchema is the synchronizable Map. We key players by their `sessionId` (a
 * unique id Colyseus assigns to each connection), so:
 *   - adds/removes of players are first-class wire events the client can listen to
 *     (onAdd / onRemove) — perfect for "spawn/despawn a remote avatar";
 *   - the key is always a string (Colyseus constraint), which sessionId already is.
 *
 * AUTHORITY MODEL (read this — it shapes everything)
 * --------------------------------------------------
 * The server is authoritative over the ROOM (who is present, the canonical
 * positions) but does NOT simulate movement. Each client computes its own avatar's
 * position locally (instant, no input lag) and pushes it via a "move" message; the
 * server just stores it here and lets Colyseus broadcast the delta. This is the
 * standard "presence relay" used by virtual-office apps. True server-side movement
 * simulation (with client prediction + reconciliation, needed for anti-cheat) is
 * deferred to F3 — see SPEC §4.
 */
export class OfficeState extends Schema {
  /** All present avatars, keyed by connection sessionId. */
  @type({ map: Player }) players = new MapSchema<Player>();
}
