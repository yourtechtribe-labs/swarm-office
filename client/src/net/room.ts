import { Client, getStateCallbacks, type Room } from '@colyseus/sdk';
import type { MapSchema } from '@colyseus/schema';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  net/room.ts — connect to the Colyseus office room
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE STRUCTURAL-TYPING BOUNDARY (important)
 * ------------------------------------------
 * We deliberately do NOT import the server's decorated `Player`/`OfficeState`
 * classes. Their `@type` decorators require `experimentalDecorators` +
 * `useDefineForClassFields:false`, which fight the client's modern Vite/React
 * tsconfig. The client only needs to READ the values the server streams, so we
 * describe their shape structurally. At runtime the objects are real Schema
 * instances; these types are just our compile-time view of them.
 *
 * VERSION LOCK
 * ------------
 * `@colyseus/sdk` (client) and `colyseus` (server) MUST stay on the same 0.17.x
 * line — the Schema binary wire format is version-locked. A mismatch deserializes
 * silently wrong (fields arrive undefined), not with a clean error.
 */

/** Our compile-time view of the server's Player schema. */
export type PlayerView = { x: number; y: number; name: string; zone: string };

/** Our compile-time view of the room state. */
export type OfficeStateView = { players: MapSchema<PlayerView> };

/**
 * Shape of one zone the server pushes via the "zones" message on join. It mirrors
 * the server's `Zone` type, but it's plain data (no Schema decorators) so sharing
 * the shape here is safe. The server stays the single source of the actual values.
 */
export type ZoneView = {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: number;
};

export type OfficeRoom = Room<OfficeStateView>;

// Server endpoint. Defaults to the local dev server; overridable per environment
// via a Vite env var (ADR-022 environments come later).
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:2567';

/**
 * Join the shared office (or create it if it's the first client).
 *
 * Under the hood joinOrCreate first does an HTTP POST to /matchmake (seat
 * reservation — subject to CORS, handled server-side) and THEN upgrades to a
 * WebSocket carrying the binary state sync.
 */
export async function connectToOffice(): Promise<OfficeRoom> {
  const client = new Client(SERVER_URL);
  return client.joinOrCreate<OfficeStateView>('office', {});
}

// Re-export so scenes get the state-callbacks proxy factory from one place.
export { getStateCallbacks };
