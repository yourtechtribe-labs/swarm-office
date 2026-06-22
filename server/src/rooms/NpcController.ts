import { Player } from './schema/Player';
import { ZONES, zoneAt, type Zone } from './zones';
import type { OfficeState } from './schema/OfficeState';
import type { AgentConfig } from '../agents/roster';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  NpcController — an AI agent's BODY in the office (F2 → generalized in F4a)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS IS
 * ------------
 * The server owns extra avatars that no browser controls: the AI agents. Each is a
 * normal `Player` in `OfficeState.players` under a synthetic key (`npc:seneca`, …)
 * with `isNpc = true`. Because it's just another player entry, every client renders
 * and interpolates it through the exact same `players.onAdd` path as a human remote —
 * the "player seam" the earlier slices were built around.
 *
 * BODY vs MIND (the F4a split — read this)
 * ----------------------------------------
 * In F2 a single NpcController owned BOTH the avatar's movement AND the reply logic
 * (hearing chat, calling the gateway, the cooldown). F4a separates those concerns:
 *   • This class is now the BODY, ONE instance per roster agent: it (a) puts the entry
 *     into state, (b) wanders it, and (later, F4b) (c) walks toward a target a `move`
 *     tool sets. It holds NO conversation state.
 *   • The MIND — taking turns, the shared transcript, pass-to-consensus — lives in the
 *     ConversationManager (one, shared). The manager reads only `key` + `currentZone`
 *     from each body (the `AgentBody` contract), so the two stay decoupled.
 * This maps cleanly onto F4b: the `move` tool just sets the target this body walks to.
 *
 * WHY A SERVER SIMULATION TICK EXISTS (it didn't before F2 — read this)
 * --------------------------------------------------------------------
 * Until F2 the server was a pure RELAY: it mutated `OfficeState` ONLY in response to a
 * client's "move" message. Nothing on the server moved on its own. An NPC has no client
 * sending "move", so SOMETHING server-side must advance its position over time — that
 * something is a simulation tick (`Room.setSimulationInterval`, wired in OfficeRoom).
 * We keep it deliberately tiny (a few agents, simple wander) so it doesn't creep toward
 * full server-authoritative simulation — that (with client prediction + reconciliation
 * for humans) is still deferred to F3.
 *
 * HOW MOVEMENT REACHES THE CLIENTS (nothing special)
 * --------------------------------------------------
 * `update(dt)` mutates the agent `Player`'s x/y/zone in place. Those fields are
 * `@type`-tracked schema fields, so Colyseus's patch loop (~20 Hz) diffs them and
 * broadcasts the binary deltas — identical to how a human's relayed position ships.
 * Clients ease the NPC sprite toward each update via the same RemotePlayer lerp.
 */

/** Wander speed (px/s). Calmer than a human (SPEED 220) so it reads as ambient. */
const NPC_SPEED = 60;
/** Keep the wander target this many px inside the zone edges so the avatar + its
 *  label never clip outside the rectangle. */
const ZONE_MARGIN = 40;
/** "Arrived" threshold (px): within this of the target, pick a new one. Avoids the
 *  asymptotic crawl of lerp-to-point (it never exactly reaches, so we snap-and-retarget). */
const ARRIVE_EPS = 4;

export class NpcController {
  /** The live schema entry we own once spawned (kept so update() can mutate it). */
  private npc?: Player;
  /** The home zone's rectangle, resolved once at spawn (for wander bounds). */
  private home!: Zone;
  /** Current wander destination in world px; the NPC walks toward it. */
  private targetX = 0;
  private targetY = 0;

  /**
   * @param config the agent's identity + home + color (from the roster). Making this a
   *   parameter — not hard-coded — is what lets OfficeRoom spawn N agents from a data
   *   list with no per-agent code (spec §4.1).
   * @param log sink for server events. OfficeRoom passes one that BOTH console.logs
   *   (terminal) AND broadcasts a `server-log` message to clients (the in-UI panel),
   *   so the same events the operator reads in the terminal also surface in the browser.
   *   Decoupled as a callback so the controller stays unaware of Colyseus.
   */
  constructor(
    private readonly state: OfficeState,
    private readonly config: AgentConfig,
    private readonly log: (level: 'info' | 'warn', text: string) => void,
  ) {}

  /** The synthetic state key of this agent (so the manager can stamp its chat lines
   *  and look its body up). Satisfies the `AgentBody` contract. */
  get key(): string {
    return this.config.key;
  }

  /** This agent's current zone id (the manager uses it to build the participant set
   *  and the room broadcasts its lines to this zone). Satisfies `AgentBody`. */
  get currentZone(): string {
    return this.npc?.zone ?? '';
  }

  /**
   * Create the agent entry in the room state. Called once per agent from
   * OfficeRoom.onCreate. After this the agent is already visible to every connected
   * client (the patch loop broadcasts the add) even before it moves.
   */
  spawn(): void {
    // Resolve the home zone geometry. Fall back to the first zone if the id ever
    // changes in zones.ts so a typo degrades to "spawn somewhere valid", not a crash.
    this.home = ZONES.find((z) => z.id === this.config.homeZone) ?? ZONES[0];

    const npc = new Player();
    // Start at the zone centre, then wander from there.
    npc.x = this.home.x + this.home.w / 2;
    npc.y = this.home.y + this.home.h / 2;
    npc.name = this.config.name;
    npc.isNpc = true;
    npc.color = this.config.color; // per-agent label tint so humans tell them apart
    // Derive the zone the same way humans do, so the value is authoritative and the
    // zone-scoped chat sees the agent in its home zone with no special-casing.
    npc.zone = zoneAt(npc.x, npc.y);

    this.state.players.set(this.config.key, npc);
    this.npc = npc;
    this.pickNewTarget();
    this.log('info', `🤖 ${this.config.name} entró en la oficina (zona "${npc.zone}")`);
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
    // wander stays inside the home rect, so this stays the home zone — but we derive
    // it rather than hard-code it, so a future free-roaming NPC just works.
    this.npc.zone = zoneAt(this.npc.x, this.npc.y);
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
