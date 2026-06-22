import { Player } from './schema/Player';
import { ZONES, zoneAt, type Zone } from './zones';
import type { OfficeState } from './schema/OfficeState';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  NpcController — an AI agent as a citizen of the office (F2a)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS IS
 * ------------
 * The server owns ONE extra avatar that no browser controls: an NPC ("M.IA"). It
 * is a normal `Player` in `OfficeState.players` under a synthetic key (`npc:mia`)
 * with `isNpc = true`. Because it's just another player entry, every client renders
 * and interpolates it through the exact same `players.onAdd` path as a human remote
 * — the "player seam" the earlier slices were built around. The controller's job is
 * only to (a) put the entry into state and (b) move it. F2a-2 will add (c) chat.
 *
 * WHY A SERVER SIMULATION TICK EXISTS NOW (it didn't before — read this)
 * ---------------------------------------------------------------------
 * Until F2 the server was a pure RELAY: it mutated `OfficeState` ONLY in response
 * to a client's "move" message (see OfficeState's authority note). Nothing on the
 * server moved on its own. An NPC has no client sending "move", so SOMETHING
 * server-side must advance its position over time — that something is a simulation
 * tick (`Room.setSimulationInterval`, wired in OfficeRoom). This is the first and,
 * for now, the ONLY server-driven mutation. We keep it deliberately tiny (one NPC,
 * simple wander) so it doesn't creep toward full server-authoritative simulation —
 * that (with client prediction + reconciliation for humans) is still deferred to F3.
 *
 * HOW MOVEMENT REACHES THE CLIENTS (nothing special)
 * --------------------------------------------------
 * `update(dt)` mutates the NPC `Player`'s x/y/zone in place. Those fields are
 * `@type`-tracked schema fields, so Colyseus's patch loop (~20 Hz) diffs them and
 * broadcasts the binary deltas — identical to how a human's relayed position ships.
 * Clients ease the NPC sprite toward each update via the same RemotePlayer lerp.
 */

/** The synthetic state key for the NPC. The `npc:` prefix can never collide with a
 *  Colyseus sessionId (those are opaque ids, not namespaced) and makes NPC entries
 *  greppable in logs/state dumps. */
export const NPC_KEY = 'npc:mia';
/** Display name humans see (also surfaces as the chat author in F2a-2). */
const NPC_NAME = 'M.IA';
/** The zone the NPC lives in. Lobby is central and is also the human spawn zone, so
 *  a joining human immediately shares M.IA's zone (handy for the F2a-2 chat demo). */
const HOME_ZONE_ID = 'lobby';
/** Wander speed (px/s). Calmer than a human (SPEED 220) so it reads as ambient. */
const NPC_SPEED = 60;
/** Keep the wander target this many px inside the zone edges so the avatar + its
 *  label never clip outside the rectangle. */
const ZONE_MARGIN = 40;
/** "Arrived" threshold (px): within this of the target, pick a new one. Avoids the
 *  asymptotic crawl of lerp-to-point (it never exactly reaches, so we snap-and-retarget). */
const ARRIVE_EPS = 4;
/** Minimum gap (ms) between NPC replies. A debounce so a human flooding the chat
 *  can't make the NPC answer every line. For the scripted F2a this just keeps it
 *  calm; in F2b the SAME gate caps how often we pay for an LLM call (spec §6). */
const REPLY_COOLDOWN_MS = 1500;

/** Scripted replies for F2a (no AI yet). F2b swaps this single function out for a
 *  call to the M.IA gateway — everything else (hearing, zone scoping, cooldown,
 *  broadcast) stays. A tiny bit of keyword shaping so it doesn't feel like one canned
 *  string, while staying fully deterministic (no external dependency). */
function scriptedReply(text: string): string {
  const t = text.toLowerCase();
  if (/\b(hola|hi|hey|buenas|hello)\b/.test(t)) return '¡Hola! Soy M.IA, vivo en el Lobby 👋';
  if (t.includes('?')) return 'Buena pregunta. De momento solo sé deambular por aquí (pronto me conectarán a una IA de verdad).';
  return `Te he oído: "${text.slice(0, 80)}"`;
}

export class NpcController {
  /** The live schema entry we own once spawned (kept so update() can mutate it). */
  private npc?: Player;
  /** The home zone's rectangle, resolved once at spawn (for wander bounds). */
  private home!: Zone;
  /** Current wander destination in world px; the NPC walks toward it. */
  private targetX = 0;
  private targetY = 0;
  /** Timestamp (ms) of the NPC's last reply, for the cooldown debounce. */
  private lastReplyAt = 0;

  constructor(private readonly state: OfficeState) {}

  /** The synthetic state key of the NPC (so the room can stamp its chat lines). */
  readonly key = NPC_KEY;

  /** The NPC's current zone id (the room broadcasts replies to this zone). */
  get currentZone(): string {
    return this.npc?.zone ?? '';
  }

  /**
   * Create the NPC entry in the room state. Called once from OfficeRoom.onCreate.
   * After this the NPC is already visible to every connected client (the patch loop
   * broadcasts the add) even before it moves.
   */
  spawn(): void {
    // Resolve the home zone geometry. Fall back to the first zone if the id ever
    // changes in zones.ts so a typo degrades to "spawn somewhere valid", not a crash.
    this.home = ZONES.find((z) => z.id === HOME_ZONE_ID) ?? ZONES[0];

    const npc = new Player();
    // Start at the zone centre, then wander from there.
    npc.x = this.home.x + this.home.w / 2;
    npc.y = this.home.y + this.home.h / 2;
    npc.name = NPC_NAME;
    npc.isNpc = true;
    // Derive the zone the same way humans do, so the value is authoritative and the
    // F2a-2 zone-scoped chat sees the NPC in HOME_ZONE_ID with no special-casing.
    npc.zone = zoneAt(npc.x, npc.y);

    this.state.players.set(NPC_KEY, npc);
    this.npc = npc;
    this.pickNewTarget();
    console.log(`[npc] spawned ${NPC_NAME} (${NPC_KEY}) in zone "${npc.zone}"`);
  }

  /**
   * Advance the NPC one simulation step. `dt` is the seconds elapsed since the last
   * tick (Colyseus passes milliseconds to the interval callback; OfficeRoom converts
   * to seconds). Step size = speed · dt, so motion is FRAME-RATE INDEPENDENT — the
   * same idea as the client's physics integration, just driven by the server clock
   * instead of the render loop.
   */
  update(dt: number): void {
    if (!this.npc) return;

    // Vector from current position to the target; its length is the remaining distance.
    const dx = this.targetX - this.npc.x;
    const dy = this.targetY - this.npc.y;
    const dist = Math.hypot(dx, dy);

    if (dist < ARRIVE_EPS) {
      // Close enough — pick a fresh destination so the wander continues next tick.
      this.pickNewTarget();
      return;
    }

    // Move at most `step` px toward the target; never overshoot (clamp to `dist`).
    // Normalising (dx/dist, dy/dist) gives a unit direction; scaling by the step
    // length walks along it. Math.min stops us jumping past the target on a long dt.
    const step = Math.min(NPC_SPEED * dt, dist);
    this.npc.x += (dx / dist) * step;
    this.npc.y += (dy / dist) * step;
    // Recompute zone from the new position (authoritative, same as humans). The
    // wander stays inside the home rect, so this stays HOME_ZONE_ID — but we derive
    // it rather than hard-code it, so a future free-roaming NPC just works.
    this.npc.zone = zoneAt(this.npc.x, this.npc.y);
  }

  /**
   * Decide whether the NPC replies to a human chat line, and with what (F2a).
   *
   * Called by OfficeRoom from INSIDE its `onMessage('chat')` handler, after the
   * human line has been delivered. Returns the reply text, or null to stay silent.
   * The room broadcasts a non-null reply via the same zone-scoped path as humans,
   * stamped `from: NPC_KEY` — crucially NOT back through `onMessage`, so the NPC's
   * own line can never re-enter here (no reply loop). That structural guarantee is
   * why this method only reads/decides; it never broadcasts itself.
   *
   * Gates (cheap → expensive, so we bail early):
   *   1. Same zone — the NPC only hears its own zone, mirroring the zone-scoped chat
   *      humans get. (Belt-and-suspenders: the room already scopes delivery, but the
   *      NPC must independently decide, since it isn't a `client` in the send loop.)
   *   2. Not itself — defensive; NPC lines don't reach onMessage, but guard anyway.
   *   3. Cooldown — at most one reply per REPLY_COOLDOWN_MS (the debounce that, in
   *      F2b, will also bound LLM spend — spec §6).
   */
  observeChat(senderKey: string, senderZone: string, text: string): string | null {
    if (!this.npc) return null;
    if (senderKey === NPC_KEY) return null;
    if (senderZone !== this.npc.zone) return null;
    const now = Date.now();
    if (now - this.lastReplyAt < REPLY_COOLDOWN_MS) return null;
    this.lastReplyAt = now;
    // F2b will replace this synchronous scripted call with an async gateway request
    // (and the broadcast will move into the awaited callback). The seam is here.
    return scriptedReply(text);
  }

  /** Choose a random point inside the home zone (minus a margin) as the next target. */
  private pickNewTarget(): void {
    const minX = this.home.x + ZONE_MARGIN;
    const minY = this.home.y + ZONE_MARGIN;
    const spanX = this.home.w - ZONE_MARGIN * 2;
    const spanY = this.home.h - ZONE_MARGIN * 2;
    this.targetX = minX + Math.random() * spanX;
    this.targetY = minY + Math.random() * spanY;
  }
}
