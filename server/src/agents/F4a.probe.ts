/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  F4a.probe — deterministic headless validation of the conversation loop
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS IS (and why it's a script, not a test framework)
 * ---------------------------------------------------------
 * The repo pins deps to exact versions and ships NO test runner (CLAUDE.md). F0–F2
 * validated "deterministically" by hand. This probe keeps that idiom: a plain `.ts`
 * run with `tsx` (already a devDep) that exercises ConversationManager on the SCRIPTED
 * turn engine — no LLM, no Colyseus, no VPN — and ASSERTS the spec §6 properties,
 * throwing (non-zero exit) on any failure. This is the F4a "RED→GREEN" harness.
 *
 * Run: `cd server && npx tsx src/agents/F4a.probe.ts`
 *
 * WHAT IT ASSERTS (spec §6 / plan §5)
 * -----------------------------------
 *   1. Round-robin ordering: agents alternate (Seneca, Marcus, Seneca, …).
 *   2. One gateway call in flight EVER (the engine throws if re-entered concurrently).
 *   3. Termination: two consecutive PASSes end the round AND a "Decidimos:" line is
 *      emitted (a finished round produces a decision, not silence — §4.3).
 *   4. Human STOP halts the round mid-flight.
 *   5. Runaway backstop fires + logs a WARNING when PASS never happens (negative test).
 */

import { ConversationManager, type TurnEngine, type AgentBody } from '../rooms/ConversationManager';
import { ROSTER } from './roster';

// ── tiny assert helper (throws → tsx exits non-zero) ────────────────────────────
let checks = 0;
function assert(cond: boolean, msg: string): void {
  checks++;
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/** Stub bodies: the manager only needs `key` + `currentZone` from a body in F4a.
 *  Both roster agents report 'lobby' so the seed (also 'lobby') includes them. */
function lobbyBodies(): Map<string, AgentBody> {
  const m = new Map<string, AgentBody>();
  for (const a of ROSTER) m.set(a.key, { key: a.key, currentZone: 'lobby' });
  return m;
}

/** A turn engine that wraps another with a re-entrancy guard, proving the manager
 *  never runs two turns concurrently (assertion #2). */
function oneInFlight(inner: TurnEngine): TurnEngine {
  let busy = false;
  return async (agent, transcript, mode) => {
    assert(!busy, 'two engine calls overlapped (concurrent gateway calls)');
    busy = true;
    try {
      await Promise.resolve(); // yield a microtask: if the manager fired two, the 2nd trips the guard
      return await inner(agent, transcript, mode);
    } finally {
      busy = false;
    }
  };
}

type Log = { level: string; text: string };

async function scenarioTermination(): Promise<void> {
  const lines: { from: string; text: string }[] = [];
  const logs: Log[] = [];
  // Speak for the first 4 turns, then PASS forever → turn 5 (Seneca) PASS, turn 6
  // (Marcus) PASS → two consecutive → consensus.
  let spoken = 0;
  const engine: TurnEngine = oneInFlight(async (agent, transcript, mode) => {
    if (mode === 'conclude') return `Decidimos: seguimos con el plan.`;
    spoken++;
    return spoken <= 4 ? `${agent.name}: aporto la idea ${spoken}.` : '[PASS]';
  });
  const cm = new ConversationManager({
    roster: ROSTER,
    bodies: lobbyBodies(),
    broadcastChat: (_zone, from, text) => lines.push({ from, text }),
    log: (level, text) => logs.push({ level, text }),
    turnEngine: engine,
    turnDelayMs: 0,
  });

  cm.seed('lobby', 'organizad la fiesta', 'Albert');
  await cm.settled();

  // The first broadcast is the seed echo (from the human), then the agent turns.
  const agentLines = lines.filter((l) => l.from.startsWith('npc:'));
  const spokenLines = agentLines.filter((l) => !l.text.startsWith('Decidimos:'));
  assert(lines[0].text === 'organizad la fiesta', 'seed is echoed to the zone first');
  // Round-robin: Seneca, Marcus, Seneca, Marcus (4 spoken lines before the passes).
  assert(spokenLines.length === 4, `expected 4 spoken agent lines, got ${spokenLines.length}`);
  assert(spokenLines[0].from === 'npc:seneca', 'Seneca speaks first');
  assert(spokenLines[1].from === 'npc:marcus', 'Marcus speaks second');
  assert(spokenLines[2].from === 'npc:seneca', 'round-robin wraps to Seneca');
  // Consensus produces a decision line.
  const decision = agentLines.find((l) => l.text.startsWith('Decidimos:'));
  assert(!!decision, 'a finished round emits a "Decidimos:" conclusion line');
  assert(!cm.isRunning, 'round is over after consensus');
  console.log('  ✓ termination: round-robin + double-PASS consensus + decision line');
}

async function scenarioStop(): Promise<void> {
  const lines: { from: string; text: string }[] = [];
  const logs: Log[] = [];
  let cmRef: ConversationManager | null = null;
  let turns = 0;
  // Never passes on its own; instead the human STOPs after the 2nd agent turn.
  const engine: TurnEngine = oneInFlight(async (agent) => {
    turns++;
    if (turns === 2) cmRef!.stop(); // simulate the human pressing /stop mid-round
    return `${agent.name}: hablando (${turns}).`;
  });
  const cm = new ConversationManager({
    roster: ROSTER,
    bodies: lobbyBodies(),
    broadcastChat: (_z, from, text) => lines.push({ from, text }),
    log: (level, text) => logs.push({ level, text }),
    turnEngine: engine,
    turnDelayMs: 0,
  });
  cmRef = cm;
  cm.seed('lobby', 'tema', 'Albert');
  await cm.settled();

  const agentLines = lines.filter((l) => l.from.startsWith('npc:'));
  // The 2nd turn triggered stop AFTER producing its line, so 2 lines max, then halt.
  assert(agentLines.length === 2, `STOP should halt after 2 lines, got ${agentLines.length}`);
  assert(logs.some((l) => /stop/i.test(l.text)), 'STOP is logged distinctly');
  assert(!cm.isRunning, 'round is halted after STOP');
  console.log('  ✓ stop: human STOP halts the round mid-flight');
}

async function scenarioRunaway(): Promise<void> {
  const lines: { from: string; text: string }[] = [];
  const logs: Log[] = [];
  // PASS is "disabled": every turn speaks, forever → the backstop must fire.
  const engine: TurnEngine = oneInFlight(async (agent) => `${agent.name}: sin parar.`);
  const cm = new ConversationManager({
    roster: ROSTER,
    bodies: lobbyBodies(),
    broadcastChat: (_z, from, text) => lines.push({ from, text }),
    log: (level, text) => logs.push({ level, text }),
    turnEngine: engine,
    turnDelayMs: 0,
    runawayCap: 8, // small cap so the negative test is fast
  });
  cm.seed('lobby', 'bucle', 'Albert');
  await cm.settled();

  const agentLines = lines.filter((l) => l.from.startsWith('npc:'));
  assert(agentLines.length === 8, `runaway should stop AT the cap (8), got ${agentLines.length}`);
  const warn = logs.find((l) => l.level === 'warn' && /runaway/i.test(l.text));
  assert(!!warn, 'runaway backstop logs LOUDLY as a WARNING (distinct from pass-termination)');
  assert(!cm.isRunning, 'round is stopped after hitting the cap');
  console.log('  ✓ runaway: backstop fires + warns when PASS never happens');
}

async function scenarioDefaultEngine(): Promise<void> {
  // No injected engine + no gateway configured (the probe doesn't load .env) → the
  // manager picks its DEFAULT scripted fallback. This locks the off-VPN RUNTIME path:
  // a round must still run AND converge to a decision with zero external setup.
  const lines: { from: string; text: string }[] = [];
  const cm = new ConversationManager({
    roster: ROSTER,
    bodies: lobbyBodies(),
    broadcastChat: (_z, from, text) => lines.push({ from, text }),
    log: () => {},
    turnDelayMs: 0,
    // turnEngine intentionally omitted → exercises the real default-selection code.
  });
  cm.seed('lobby', 'tema off-VPN', 'Albert');
  await cm.settled();

  const agentLines = lines.filter((l) => l.from.startsWith('npc:'));
  assert(agentLines.length > 0, 'default scripted engine produces agent turns');
  assert(agentLines.some((l) => l.text.startsWith('Decidimos:')), 'scripted round converges to a decision');
  assert(!cm.isRunning, 'scripted round ends on its own (no VPN needed)');
  console.log('  ✓ default engine: off-VPN scripted fallback round converges');
}

async function main(): Promise<void> {
  console.log('F4a probe — conversation loop (scripted, deterministic)');
  await scenarioTermination();
  await scenarioStop();
  await scenarioRunaway();
  await scenarioDefaultEngine();
  console.log(`\n✅ F4a probe passed (${checks} assertions)`);
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
