/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  F6.probe — deterministic validation of the workspace-explorer plumbing
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Covers the two UNITS that don't need Colyseus (the ws-list/ws-read room glue is exercised
 * by the deployed clicktest, T6):
 *   1. workspaceClient — against a tiny stub HTTP server: list/read parse the JSON, and a
 *      transport failure (no server) degrades to `{ error }` instead of throwing.
 *   2. onWorkspaceChanged — a do_work turn fires the refresh callback with the round's zone
 *      (the push that drives the live tree refresh), via the real ConversationManager.
 *
 * Run: `cd server && npx tsx src/agents/F6.probe.ts`
 */

import http from 'node:http';
import { ConversationManager, type TurnEngine } from '../rooms/ConversationManager';
import type { AgentBody } from '../rooms/tools';
import type { WorkClient } from '../rooms/workClient';
import { makeWorkspaceClient } from '../rooms/workspaceClient';
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

async function scenarioWorkspaceClient(): Promise<void> {
  // A stub that mimics the harness's /files and /file JSON.
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.startsWith('/files')) res.end(JSON.stringify({ files: ['a.md', 'sub/b.py'] }));
    else if (req.url?.startsWith('/file')) res.end(JSON.stringify({ path: 'a.md', content: '# hola', truncated: false }));
    else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const client = makeWorkspaceClient(`http://127.0.0.1:${port}`);

  const listed = await client.list('/ws/lobby');
  assert('files' in listed && listed.files.length === 2, 'list() parses { files }');
  const file = await client.read('/ws/lobby', 'a.md');
  assert('content' in file && file.content === '# hola' && file.truncated === false, 'read() parses { content, truncated }');
  await new Promise<void>((r) => server.close(() => r()));

  // Transport failure (nothing listening) must degrade to { error }, never throw.
  const dead = makeWorkspaceClient('http://127.0.0.1:9');
  const err = await dead.list('/ws/lobby');
  assert('error' in err, 'a transport failure resolves to { error } (no throw)');
  console.log('  ✓ workspaceClient: list/read parse JSON; harness-down → { error }');
}

async function scenarioWorkspaceChanged(): Promise<void> {
  const fired: string[] = [];
  const workClient: WorkClient = async () => ({ summary: 'hecho', files: ['out.py'], stopReason: 'end_turn' });
  let worked = false;
  const engine: TurnEngine = async (_a, _t, mode) => {
    if (mode === 'conclude') return { text: 'Decidimos: ok.', toolCalls: [] };
    if (!worked) {
      worked = true;
      return { text: null, toolCalls: [{ name: 'do_work', args: { goal: 'haz algo' } }] };
    }
    return { text: '[PASS]', toolCalls: [] };
  };
  const cm = new ConversationManager({
    roster: ROSTER, bodies: lobbyBodies(),
    broadcastChat: () => {}, log: () => {},
    turnEngine: engine, workClient, turnDelayMs: 0,
    onWorkspaceChanged: (zone) => fired.push(zone),
  });
  cm.seed('lobby', 'haz algo en el workspace', 'Albert');
  await cm.settled();
  assert(fired.length >= 1, 'onWorkspaceChanged fires after a work turn (drives the live refresh)');
  assert(fired[0] === 'lobby', 'it reports the round zone');
  console.log('  ✓ onWorkspaceChanged: a do_work turn pushes a refresh signal for its zone');
}

async function main(): Promise<void> {
  console.log('F6 probe — workspace explorer (workspaceClient + onWorkspaceChanged)');
  await scenarioWorkspaceClient();
  await scenarioWorkspaceChanged();
  console.log(`\n✅ F6 probe passed (${checks} assertions)`);
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
