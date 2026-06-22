import type { ToolDef, ToolCall } from './miaGateway';
import { ZONES } from './zones';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  tools — the agent tool registry (F4b): turning speech into ACTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS IS
 * ------------
 * F4a let agents TALK to each other. F4b lets a turn also DO something: the gateway
 * call now carries `tools` (JSON-schema function defs), the model may answer with a
 * `tool_calls` array (verified live shape — see F4b-toolcheck), and we look each call
 * up in this registry and run it SERVER-SIDE. v1 is deliberately SINGLE-STEP: execute
 * the call and finish the turn — no ReAct loop feeding the result back for another call.
 *
 * THE TWO v1 TOOLS
 * ----------------
 *   • move(target)  — the agent walks to a zone (or toward a teammate). It just sets
 *     the body's target; the existing wander tick walks there. Out of its zone, the
 *     agent naturally leaves the (zone-scoped) conversation.
 *   • yield_turn()  — the F4a `[PASS]` sentinel, formalized as a tool: "I have nothing
 *     to add". The ConversationManager treats a yield_turn call as a PASS; it is NOT
 *     "executed" here (it's a signal, not an action), so it has no handler.
 *
 * SECURITY (spec §5)
 * ------------------
 * Tool args are UNTRUSTED model output: every handler VALIDATES before acting (a bad
 * target is rejected + logged, never executed) and nothing is ever eval'd.
 */

/** The minimal view of an agent's "body" that tools operate on. NpcController satisfies
 *  it structurally; the ConversationManager re-exports this as its `bodies` contract.
 *  `moveToZone` returns false for an unknown zone (so the handler can reject cleanly). */
export type AgentBody = {
  readonly key: string;
  readonly currentZone: string;
  moveToZone(zoneId: string): boolean;
  /** Round-lifecycle reset: snap the agent back to its home zone (the conversation hub),
   *  so a move-heavy round doesn't leave it stranded and the next round has quorum. */
  returnHome(): void;
};

/** What a handler needs to act: who is calling, and the full body map (so `move` can
 *  resolve "toward:<agentKey>" to that teammate's current zone). */
export type ToolContext = {
  agentKey: string;
  bodies: Map<string, AgentBody>;
};

/** The tool name the manager interprets as a PASS (handled there, not executed here). */
export const YIELD_TURN = 'yield_turn';

/** The OpenAI-shaped definitions sent to the gateway as `tools`. Kept minimal for v1
 *  (spec §4.7/§8). Descriptions are in Spanish to match the agents' register. */
export const TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'move',
      // Constrain target to the REAL zone ids (enum + listing them in the description),
      // so the model picks a valid zone instead of inventing a name. Discovered in the
      // F4b E2E: without this the model guessed "conferencias"/"meeting_room" and every
      // move was rejected. (The handler ALSO accepts "toward:<agentKey>" — kept for
      // programmatic/future use + covered by the probe — but we don't advertise it to
      // the model here, to keep the enum a hard constraint.)
      description: `Muévete a otra zona de la oficina. El destino DEBE ser uno de estos ids: ${ZONES.map((z) => z.id).join(', ')}.`,
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: [...ZONES.map((z) => z.id)], description: 'id de zona destino' },
        },
        required: ['target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: YIELD_TURN,
      description: 'Cede el turno: no tienes nada más que añadir o estás de acuerdo en que el tema está resuelto.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

/** Run a (non-yield) tool call against the world. Returns a short human-readable note
 *  for the server log; throws nothing (a rejected call returns an explanatory note so
 *  the round continues). The manager handles `yield_turn` itself and never calls this
 *  for it. */
export function executeToolCall(call: ToolCall, ctx: ToolContext): { ok: boolean; note: string } {
  if (call.name === 'move') return runMove(call, ctx);
  return { ok: false, note: `herramienta desconocida "${call.name}" (ignorada)` };
}

/** move(target): validate the target → a known zone id, or "toward:<agentKey>" resolved
 *  to that teammate's current zone. Set the caller's body target; reject unknown targets. */
function runMove(call: ToolCall, ctx: ToolContext): { ok: boolean; note: string } {
  const raw = typeof call.args.target === 'string' ? call.args.target.trim() : '';
  if (!raw) return { ok: false, note: 'move sin "target" (rechazado)' };

  const body = ctx.bodies.get(ctx.agentKey);
  if (!body) return { ok: false, note: `cuerpo del agente "${ctx.agentKey}" no encontrado` };

  // Resolve "toward:<agentKey>" to that teammate's current zone.
  let zoneId = raw;
  if (raw.startsWith('toward:')) {
    const otherKey = raw.slice('toward:'.length);
    const other = ctx.bodies.get(otherKey);
    if (!other) return { ok: false, note: `move toward "${otherKey}": ese agente no existe (rechazado)` };
    zoneId = other.currentZone;
  }

  const moved = body.moveToZone(zoneId);
  return moved
    ? { ok: true, note: `→ se mueve a la zona "${zoneId}"` }
    : { ok: false, note: `zona "${zoneId}" desconocida (rechazado)` };
}
