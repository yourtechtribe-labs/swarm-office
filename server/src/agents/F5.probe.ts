/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  F5.probe — deterministic validation of the work turn (do_work → harness)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Same idiom as F4: a tsx script with an injected engine AND an injected workClient stub,
 * so the whole work-turn flow runs with NO harness service and NO LLM. Asserts:
 *   1. success — a do_work turn calls the workClient (goal+workspace+model), streams its
 *      tool events to the log, and the work summary becomes the agent's broadcast line;
 *      the round still converges.
 *   2. degrade — workClient resolves null (service down/aborted) → a degrade chat line,
 *      the round keeps going (spec R6).
 *   3. no service — no workClient injected → do_work degrades to an explanatory line.
 */

import { ConversationManager, type TurnEngine } from '../rooms/ConversationManager';
import type { AgentBody } from '../rooms/tools';
import type { WorkClient, WorkRequest } from '../rooms/workClient';
import { ROSTER } from './roster';

let checks = 0;
function assert(cond: boolean, msg: string): void {
  checks++;
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function lobbyBodies(): Map<string, AgentBody> {
  const m = new Map<string, AgentBody>();
  for (const a of ROSTER) m.set(a.key, { key: a.key, currentZone: 'lobby', moveToZone: () => true, returnHome: () => {} });
  return m;
}

const GOAL = 'calcula la secuencia de Fibonacci hasta 5 y guárdala';

/** Engine: turn 1 = do_work(GOAL), every later turn = [PASS] (so the round converges). */
function workThenPass(): TurnEngine {
  let turn = 0;
  return async (_a, _t, mode) => {
    if (mode === 'conclude') return { text: 'Decidimos: trabajo terminado.', toolCalls: [] };
    turn++;
    return turn === 1
      ? { text: null, toolCalls: [{ name: 'do_work', args: { goal: GOAL } }] }
      : { text: '[PASS]', toolCalls: [] };
  };
}

async function scenarioSuccess(): Promise<void> {
  const lines: { from: string; text: string }[] = [];
  const logs: string[] = [];
  let calls = 0;
  let lastReq: WorkRequest | null = null;
  const workClient: WorkClient = async (req, onEvent) => {
    calls++;
    lastReq = req;
    onEvent({ kind: 'tool', name: 'write_file', input: { path: 'fib.py' }, output: 'wrote 40 bytes to fib.py' });
    onEvent({ kind: 'tool', name: 'run_code', input: {}, output: '0 1 1 2 3' });
    return { summary: 'Hecho: fib.py calcula la secuencia (probado, da 0 1 1 2 3).', files: ['fib.py'], stopReason: 'end_turn' };
  };
  const cm = new ConversationManager({
    roster: ROSTER, bodies: lobbyBodies(),
    broadcastChat: (_z, from, text) => lines.push({ from, text }),
    log: (_l, text) => logs.push(text),
    turnEngine: workThenPass(), workClient, workModel: 'vllm/test',
    zoneWorkspace: (z) => `/tmp/ws/${z}`, turnDelayMs: 0,
  });
  cm.seed('lobby', 'haced fib de verdad', 'Albert');
  await cm.settled();

  assert(calls === 1, `harness called once, got ${calls}`);
  assert(lastReq!.goal === GOAL, 'the agent-decided goal is forwarded');
  assert(lastReq!.workspace === '/tmp/ws/lobby', 'the zone workspace is forwarded');
  assert(lastReq!.model === 'vllm/test', 'the work model is forwarded');
  assert(lines.some((l) => l.text.startsWith('Hecho: fib.py')), 'the work summary becomes the agent line');
  assert(logs.some((t) => /🛠/.test(t)), 'work start is logged');
  assert(logs.some((t) => /🔧 write_file/.test(t)), 'tool events stream to the log');
  assert(!cm.isRunning, 'the round converges after the work turn');
  console.log('  ✓ success: do_work runs the harness, streams tools, summary is the line');
}

async function scenarioDegrade(): Promise<void> {
  const lines: { from: string; text: string }[] = [];
  const workClient: WorkClient = async () => null; // service down / unreachable
  const cm = new ConversationManager({
    roster: ROSTER, bodies: lobbyBodies(),
    broadcastChat: (_z, from, text) => lines.push({ from, text }),
    log: () => {},
    turnEngine: workThenPass(), workClient, turnDelayMs: 0,
  });
  cm.seed('lobby', 'haced fib', 'Albert');
  await cm.settled();
  assert(lines.some((l) => /No he podido completar/.test(l.text)), 'degrade line on null result');
  assert(!cm.isRunning, 'the round still ends after a failed work turn');
  console.log('  ✓ degrade: a failed work turn becomes a chat line, round continues');
}

async function scenarioNoService(): Promise<void> {
  const lines: { from: string; text: string }[] = [];
  const cm = new ConversationManager({
    roster: ROSTER, bodies: lobbyBodies(),
    broadcastChat: (_z, from, text) => lines.push({ from, text }),
    log: () => {},
    turnEngine: workThenPass(), turnDelayMs: 0, // NO workClient
  });
  cm.seed('lobby', 'haced fib', 'Albert');
  await cm.settled();
  assert(lines.some((l) => /no hay servicio de trabajo/.test(l.text)), 'explains there is no work service');
  assert(!cm.isRunning, 'round ends');
  console.log('  ✓ no-service: do_work degrades to an explanatory line');
}

async function scenarioIncomplete(): Promise<void> {
  // STRUCTURED signal: the work hit the step cap (stopReason='max_steps'). The office must
  // surface a graceful line (still showing files), NOT the raw summary — and never grep text.
  const lines: { from: string; text: string }[] = [];
  const workClient: WorkClient = async () => ({
    summary: 'partial internal text that should NOT be shown verbatim',
    files: ['draft.md'],
    stopReason: 'max_steps',
  });
  const cm = new ConversationManager({
    roster: ROSTER, bodies: lobbyBodies(),
    broadcastChat: (_z, from, text) => lines.push({ from, text }),
    log: () => {},
    turnEngine: workThenPass(), workClient, turnDelayMs: 0,
  });
  cm.seed('lobby', 'tarea larga', 'Albert');
  await cm.settled();
  const agentLine = lines.find((l) => l.from.startsWith('npc:'));
  assert(/no la he terminado del todo/.test(agentLine?.text ?? ''), 'max_steps → graceful incomplete line');
  assert(/draft\.md/.test(agentLine?.text ?? ''), 'incomplete line still surfaces the files produced');
  assert(!/partial internal text/.test(agentLine?.text ?? ''), 'the raw summary is NOT shown on an incomplete turn');
  console.log('  ✓ incomplete: stopReason=max_steps → graceful line (structured, not text-grep)');
}

async function main(): Promise<void> {
  console.log('F5 probe — work turns (do_work → harness)');
  await scenarioSuccess();
  await scenarioDegrade();
  await scenarioNoService();
  await scenarioIncomplete();
  console.log(`\n✅ F5 probe passed (${checks} assertions)`);
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
