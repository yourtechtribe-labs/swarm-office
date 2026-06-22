/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  zones.ts — the office's named areas (server-owned source of truth)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Zones are static rectangles in world space. The server is the single owner of
 * this geometry: it computes each player's current zone (membership) AND pushes
 * the rectangles to clients on join so they can be drawn. Clients never define
 * zones themselves — that avoids drift and matches the F3 plan where zones will be
 * loaded from a Tiled map here on the server.
 *
 * WHY MEMBERSHIP LIVES ON THE SERVER
 * ----------------------------------
 * The server already receives every position via "move", so it can derive `zone`
 * for free and store it in the synced state. Then EVERY client knows who is in
 * which zone (delta-synced) — the foundation for F1 proximity audio ("group the
 * people in the Meeting Room"). Computing it only on each client would leave that
 * cross-player knowledge nowhere.
 *
 * Coordinates are world pixels; the world is 1600×1200 (see client OfficeScene).
 * The spawn point (800,600) sits inside "lobby" on purpose, so a player that joins
 * and never moves still reports a real zone.
 */
export type Zone = {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Render tint (hex) — used by the client only. */
  color: number;
};

export const ZONES: Zone[] = [
  { id: 'lobby', name: 'Lobby', x: 650, y: 450, w: 300, h: 300, color: 0x4fd1c5 },
  { id: 'meeting', name: 'Meeting Room', x: 150, y: 150, w: 450, h: 300, color: 0xf6ad55 },
  { id: 'kitchen', name: 'Kitchen', x: 1050, y: 150, w: 400, h: 300, color: 0xfc8181 },
  { id: 'desks', name: 'Desks', x: 400, y: 850, w: 800, h: 300, color: 0x9f7aea },
];

/**
 * Returns the id of the first zone whose rectangle contains (x, y), or '' if the
 * point is in no zone. Plain point-in-rectangle test: a point is inside iff it is
 * within the half-open span [x, x+w) on each axis. Half-open so adjacent zones
 * never both claim a shared edge.
 */
export function zoneAt(x: number, y: number): string {
  for (const z of ZONES) {
    if (x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) {
      return z.id;
    }
  }
  return '';
}
