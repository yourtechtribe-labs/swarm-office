# DESIGN — F5: work turns

> Phase: **design** (Cross-Module). Reads `SPEC.md`. Two repos: `swarm-office` (TS,
> driver) + `predicta-harness` (Py, work backend). KB: greenfield; reuses F4's
> `TurnEngine`/tool-registry/one-in-flight/STOP and the sandbox (`sandbox_tools` +
> `BubblewrapSandbox`). Grounded in the real code of both (already authored this session).
> Next: /03-tasks.

## 1. The seam (why this is a small change, not a rewrite)

The agent "decides to work" by calling a new **`do_work(goal)`** tool (it states its own
goal — emergent). In `ConversationManager.runRound`, a turn whose `toolCalls` include
`do_work` is handled SPECIALLY: instead of the sync `executeToolCall`, the manager runs an
**async work flow** — POST the goal to the predicta-harness service, stream its SSE
tool-calls to the `server-log`, await `{summary, files}`, and broadcast the **summary as
the agent's spoken line**. Everything else (one-in-flight, STOP, consensus) is unchanged —
a work turn is just a turn that takes longer and streams. The TS↔Py boundary is one HTTP
client; the Python side reuses `Agent` + `sandbox_tools` verbatim.

## 2. File map

### A) swarm-office (TS, driver)
```
MODIFY server/src/rooms/tools.ts          # + DO_WORK tool def (goal:string) + WORK const
CREATE server/src/rooms/workClient.ts     # HTTP+SSE client to the harness /work
MODIFY server/src/rooms/ConversationManager.ts
                                          # runRound: detect do_work → runWorkTurn() (async,
                                          #   stream SSE→log, await summary→broadcast); states
                                          #   decided/working/reporting/failed/stopped; degrade
MODIFY server/src/rooms/OfficeRoom.ts     # inject workClient (HARNESS_URL env) + zone→workspace
MODIFY server/src/agents/F4b.probe.ts? → CREATE server/src/agents/F5.probe.ts
                                          # deterministic: inject a work engine, assert states
```

### B) predicta-harness (Py, work backend)
```
CREATE src/predicta_harness/service/__init__.py
CREATE src/predicta_harness/service/app.py     # http.server handler: POST /work (SSE), GET /healthz
CREATE src/predicta_harness/service/__main__.py# `python -m predicta_harness.service` (daemon)
CREATE tests/test_service.py                   # scripted provider → assert SSE tool/done + file written
MODIFY pyproject.toml                          # (optional) console_script `predicta-harness-serve`
```
> Python side adds **no runtime deps** — `http.server` (stdlib) + the existing `Agent`,
> `sandbox_tools`, `BubblewrapSandbox`. The sandbox is the security boundary; the HTTP
> server only marshals goal → loop → SSE.

## 3. Contracts (exact)

### 3.1 office — `do_work` tool (offered to the live model alongside move/yield_turn)
```ts
// tools.ts
export const DO_WORK = 'do_work';
// TOOL_DEFS += { type:'function', function:{ name:'do_work',
//   description:'Realiza una tarea de trabajo real (escribir/ejecutar código, generar
//     ficheros) en el espacio de trabajo compartido. Indica el OBJETIVO en una frase.',
//   parameters:{ type:'object', properties:{ goal:{type:'string'} }, required:['goal'] } } }
```

### 3.2 office — work client (TS)
```ts
// workClient.ts
export type WorkEvent =
  | { kind: 'tool'; name: string; input: unknown; output: string }
  | { kind: 'done'; summary: string; files: string[]; steps: number }
  | { kind: 'error'; message: string };
export type WorkClient = (
  req: { agentKey: string; goal: string; workspace: string; model: string },
  onEvent: (e: WorkEvent) => void,   // called per SSE event (tool → server-log)
) => Promise<{ summary: string; files: string[] } | null>;  // null on transport failure (degrade)
```
- Implemented with `node:http` (POST + parse `text/event-stream`). Injected into the
  manager (like `broadcastChat`/`log`) so the F5 probe can stub it.

### 3.3 office — ConversationManager work flow (TS)
```ts
// inside runRound, when a turn's toolCalls include DO_WORK with args.goal:
//   this.log('info', `🛠 ${agent.name} se pone a trabajar: "${goal}"`)          // decided
//   const res = await this.workClient(
//     { agentKey: agent.key, goal, workspace: this.zoneWorkspace(this.zone), model },
//     (e) => { if (e.kind==='tool') this.log('info', `   🔧 ${e.name} → ${trunc(e.output)}`) }) // working
//   if (!res) { broadcast a degrade chat line; consecutivePasses=0; continue }     // failed (R6)
//   broadcastChat(zone, agent.key, res.summary); lastSpeaker = agent                // reporting
//   // one-in-flight holds: the loop awaited the whole work turn before the next turn.
```
- STOP during work: the manager passes its `stopped` check after the await; STOP also
  aborts the HTTP request (workClient supports an abort signal). Partial files kept (R5).

### 3.4 harness — HTTP service (Py)
```
POST /work   body(JSON): { agentKey, goal, workspace, model, maxSteps? }
  → Workspace(workspace); BubblewrapSandbox(ws); tools = sandbox_tools(ws, sandbox)
  → Agent(model=model, system=WORK_SYSTEM, tools=tools, max_steps=maxSteps,
          on_tool=lambda n,i,o: _sse(w,'tool',{name:n,input:i,output:o}))
  → result = agent.run(goal, extra_body={chat_template_kwargs:{enable_thinking:False}})
  → _sse(w,'done',{summary:result.text, files:ws.list_files(), steps:result.steps, usage:str(result.usage)})
  (on exception → _sse(w,'error',{message:str(e)}))
GET /healthz → 200 "ok"   (also constructs a BubblewrapSandbox to confirm bwrap present)
Run: `python -m predicta_harness.service --host 127.0.0.1 --port 8088`
```
- `_sse(w, event, data)`: writes `event: <event>\ndata: <json>\n\n` and flushes — SSE over
  stdlib `http.server` (set `Content-Type: text/event-stream`, no buffering).
- `on_tool` fires live inside the ReAct loop → each executed sandbox tool streams immediately.

## 4. Work-turn sequence

```mermaid
sequenceDiagram
  participant Mdl as office model (Seneca)
  participant CM as ConversationManager
  participant HS as harness /work
  participant SB as Sandbox(bwrap)
  Mdl->>CM: tool_call do_work(goal="compute fib to N, save it")
  CM->>HS: POST /work {goal, workspace, model}
  HS->>SB: write_file fib.py ; run_code
  HS-->>CM: SSE tool(write_file) ; SSE tool(run_code → "0 1 1 2 3 5…")
  CM-->>CM: server-log streams each tool
  HS-->>CM: SSE done {summary, files:[fib.py]}
  CM-->>Mdl: broadcast summary as Seneca's line ; fib.py persists in zone ws
```

```text
 model      ConversationManager        harness /work          Sandbox
  │ do_work(goal) ─►│
  │                 │ POST /work ─────────► run ReAct ──► write_file fib.py
  │                 │ ◄ SSE tool(write_file)              run_code → "0 1 1 2 3 5…"
  │                 │ ◄ SSE tool(run_code)    (each → server-log, live)
  │                 │ ◄ SSE done{summary,files}
  │◄ Seneca dice: "Hecho: fib.py calcula … (probado, da 0 1 1 2 3 5)"
  │                 fib.py queda en el workspace de la zona (persistente)
```

## 5. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Async tool (do_work) in a sync tool model | Handle `do_work` as a SPECIAL case in runRound (await the HTTP), not via the sync `executeToolCall`; move/yield_turn stay sync |
| SSE over stdlib `http.server` | Plain chunked writes + flush; tested by `test_service.py` reading the event stream; keep the server single-threaded-per-request (`ThreadingHTTPServer`) |
| Harness daemon lifecycle (who starts it) | Run as a `systemd` unit on dev-instance (per the /vm long-process rule, `systemd-run`/unit, MemoryMax); office degrades if it's down (R6) |
| One-in-flight + a long work turn blocks the round | Acceptable v1 (R2); work turns are deliberate. A future async-parallel model is out of scope |
| STOP must abort an in-flight HTTP | workClient takes an AbortSignal; manager aborts on STOP; partial files kept |
| Secrets / model creds in the service | The harness reads the vLLM creds from its own env (same pattern as the example), never from the office; office only sends goal+workspace+model id |
| Workspace path injection from office | service validates `workspace` under a configured root before constructing Workspace (defense in depth on top of the Workspace jail) |

## 6. Design level: MEDIUM-HIGH — cross-repo, new service, but each side reuses an existing
seam (TurnEngine / Agent+sandbox_tools). No changes to the F4 loop invariants or the sandbox.
