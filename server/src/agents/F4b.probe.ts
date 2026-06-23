/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  F4b.probe — deterministic headless validation of tool-calling (move, yield_turn)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Same idiom as F4a.probe: a tsx script, scripted/injected engines, asserts (throws on
 * failure). Validates F4b WITHOUT the gateway:
 *   1. executeToolCall (unit): move to a valid zone acts; invalid/empty/unknown reject;
 *      "toward:<agentKey>" resolves to that teammate's zone.
 *   2. Manager: a turn that emits a `move` tool call ACTS (body.moveToZone called) and
 *      does NOT count as a pass; a `yield_turn` tool call IS a pass (two → consensus).
 *
 * Run: `cd server && npx tsx src/agents/F4b.probe.ts`
 */

import { ConversationManager, type TurnEngine } from '../rooms/ConversationManager';
import { executeToolCall, YIELD_TURN, type AgentBody, type ToolContext } from '../rooms/tools';
import { ROSTER } from './roster';

let checks = 0;
function assert(cond: boolean, msg: string): void {
  checks++;
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/** A spy body: a MUTABLE currentZone (so multi-round tests see relocation + reset),
 *  records moveToZone calls, and accepts only the zones in `known`. */
type SpyBody = AgentBody & { moves: string[] };
function spyBody(key: string, home: string, known: string[]): SpyBody {
  const moves: string[] = [];
  let cur = home;
  return {
    key,
    get currentZone() {
      return cur;
    },
    moves,
    moveToZone(zoneId: string) {
      if (!known.includes(zoneId)) return false;
      cur = zoneId;
      moves.push(zoneId);
      return true;
    },
    returnHome() {
      cur = home;
    },
  };
}

function bodiesIn(zone: string, known: string[]): Map<string, SpyBody> {
  const m = new Map<string, SpyBody>();
  for (const a of ROSTER) m.set(a.key, spyBody(a.key, zone, known));
  return m;
}

function scenarioExecuteToolCall(): void {
  const bodies = bodiesIn('lobby', ['lobby', 'cafe']) as Map<string, AgentBody>;
  const ctx: ToolContext = { agentKey: 'npc:seneca', bodies };

  const ok = executeToolCall({ id: '1', name: 'move', args: { target: 'cafe' } }, ctx);
  assert(ok.ok, 'move to a known zone is accepted');
  assert((bodies.get('npc:seneca') as SpyBody).moves.at(-1) === 'cafe', 'move calls moveToZone with the target zone');

  const bad = executeToolCall({ id: '2', name: 'move', args: { target: 'mars' } }, ctx);
  assert(!bad.ok, 'move to an unknown zone is rejected (not executed)');

  const empty = executeToolCall({ id: '3', name: 'move', args: {} }, ctx);
  assert(!empty.ok, 'move with no target is rejected');

  // "toward:<agentKey>" resolves to that teammate's current zone (marcus is in 'lobby').
  const toward = executeToolCall({ id: '4', name: 'move', args: { target: 'toward:npc:marcus' } }, ctx);
  assert(toward.ok, 'move toward a teammate resolves to their zone');
  assert((bodies.get('npc:seneca') as SpyBody).moves.at(-1) === 'lobby', 'toward:<key> moves to the teammate\'s zone');

  const unknownTool = executeToolCall({ id: '5', name: 'teleport', args: {} }, ctx);
  assert(!unknownTool.ok, 'an unknown tool name is rejected');

  console.log('  ✓ executeToolCall: move valid/invalid/empty/toward + unknown tool');
}

async function scenarioManagerMove(): Promise<void> {
  const bodies = bodiesIn('lobby', ['lobby', 'cafe']);
  const lines: { from: string; text: string }[] = [];
  let turn = 0;
  // Turn 1: speak + move to 'cafe'. Then PASS forever → converges.
  const engine: TurnEngine = async (agent, _t, mode) => {
    if (mode === 'conclude') return { text: 'Decidimos: nos vemos en la cafetería.', toolCalls: [] };
    turn++;
    if (turn === 1) return { text: 'Voy a la cafetería a prepararlo.', toolCalls: [{ name: 'move', args: { target: 'cafe' } }] };
    return { text: '[PASS]', toolCalls: [] };
  };
  const cm = new ConversationManager({
    roster: ROSTER,
    bodies: bodies as Map<string, AgentBody>,
    broadcastChat: (_z, from, text) => lines.push({ from, text }),
    log: () => {},
    turnEngine: engine,
    turnDelayMs: 0,
  });
  cm.seed('lobby', 'dónde celebramos', 'Albert');
  await cm.settled();

  assert((bodies.get('npc:seneca') as SpyBody).moves.includes('cafe'), 'a move tool call actually moves the body');
  const agentLines = lines.filter((l) => l.from.startsWith('npc:'));
  assert(agentLines.some((l) => l.text.startsWith('Voy a la cafetería')), 'a speak+move turn still broadcasts its text');
  assert(agentLines.some((l) => l.text.startsWith('Decidimos:')), 'round converges to a decision after the move');
  assert(!cm.isRunning, 'round ended');
  console.log('  ✓ manager: move tool acts (body moved) + round still converges');
}

async function scenarioYieldIsPass(): Promise<void> {
  const bodies = bodiesIn('lobby', ['lobby']);
  const lines: { from: string; text: string }[] = [];
  // Every turn yields → two consecutive yields = consensus, immediately.
  const engine: TurnEngine = async (_a, _t, mode) => {
    if (mode === 'conclude') return { text: 'Decidimos: nada que añadir.', toolCalls: [] };
    return { text: null, toolCalls: [{ name: YIELD_TURN, args: {} }] };
  };
  const cm = new ConversationManager({
    roster: ROSTER,
    bodies: bodies as Map<string, AgentBody>,
    broadcastChat: (_z, from, text) => lines.push({ from, text }),
    log: () => {},
    turnEngine: engine,
    turnDelayMs: 0,
  });
  cm.seed('lobby', 'algo trivial', 'Albert');
  await cm.settled();

  // Two yields end the round; no agent ever spoke, so there's no lastSpeaker → no
  // decision line (only the human seed was broadcast).
  const agentLines = lines.filter((l) => l.from.startsWith('npc:'));
  assert(agentLines.length === 0, 'yield_turn turns broadcast nothing');
  assert(!cm.isRunning, 'two yield_turn calls end the round (yield = PASS)');
  console.log('  ✓ manager: yield_turn is treated as a PASS (two → consensus)');
}

async function scenarioMultiRound(): Promise<void> {
  // The bug the F4b E2E missed: move permanently relocates an agent, so after a
  // move-heavy round the agents are scattered and a 2nd /seed from the hub finds <2 →
  // no round. The fix: agents return home at round end. This locks it.
  const bodies = bodiesIn('lobby', ['lobby', 'kitchen', 'meeting']);
  const logs: { level: string; text: string }[] = [];
  let phase = 1;
  let p1 = 0;
  const engine: TurnEngine = async (_agent, _t, mode) => {
    if (mode === 'conclude') return { text: 'Decidimos: ok.', toolCalls: [] };
    if (phase === 1) {
      const i = p1++;
      if (i === 0) return { text: null, toolCalls: [{ name: 'move', args: { target: 'kitchen' } }] };
      if (i === 1) return { text: null, toolCalls: [{ name: 'move', args: { target: 'meeting' } }] };
      return { text: '[PASS]', toolCalls: [] };
    }
    return { text: '[PASS]', toolCalls: [] }; // phase 2: converge immediately
  };
  const cm = new ConversationManager({
    roster: ROSTER,
    bodies: bodies as Map<string, AgentBody>,
    broadcastChat: () => {},
    log: (level, text) => logs.push({ level, text }),
    turnEngine: engine,
    turnDelayMs: 0,
  });

  cm.seed('lobby', 'ronda 1 con movimiento', 'Albert');
  await cm.settled();
  assert(bodies.get('npc:seneca')!.currentZone === 'lobby', 'agent returns to the hub after a move-heavy round');
  assert(bodies.get('npc:marcus')!.currentZone === 'lobby', 'both agents reconvene at the hub');

  phase = 2;
  cm.seed('lobby', 'ronda 2 desde el hub', 'Albert');
  await cm.settled();
  const seeded = logs.filter((l) => /ronda sembrada/.test(l.text)).length;
  const ignored = logs.filter((l) => /seed ignorado/.test(l.text)).length;
  assert(seeded === 2 && ignored === 0, `the 2nd seed has quorum (sembrada=${seeded}, ignorado=${ignored})`);
  console.log('  ✓ multi-round: agents reconvene → a 2nd seed from the hub still works');
}

async function main(): Promise<void> {
  console.log('F4b probe — tool-calling (move, yield_turn)');
  scenarioExecuteToolCall();
  await scenarioManagerMove();
  await scenarioYieldIsPass();
  await scenarioMultiRound();
  console.log(`\n✅ F4b probe passed (${checks} assertions)`);
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
