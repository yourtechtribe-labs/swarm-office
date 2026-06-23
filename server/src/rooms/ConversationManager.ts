import { gatewayConfigured, gatewayChat, type ChatMessage } from './miaGateway';
import type { AgentConfig } from '../agents/roster';
import { TOOL_DEFS, YIELD_TURN, DO_WORK, executeToolCall, type AgentBody, type ToolContext } from './tools';
import type { WorkClient } from './workClient';

// Re-export the body contract so callers (and the probe) get it from the manager, even
// though it's DEFINED in tools.ts (where the tool handlers operate on it).
export type { AgentBody } from './tools';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ConversationManager — the "mind" that lets agents talk to each other (F4a)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS IS — AND WHY IT'S THE HEART OF F4
 * -------------------------------------------
 * F2 wired ONE NPC to answer humans. The one thing that did NOT exist — and is the
 * real work of F4a — is letting ≥2 agents TAKE TURNS talking to each other and STOP
 * on their own. This class owns exactly that. It is the office's "mind"; the
 * NpcControllers are the "bodies" (they only wander + hold a movable target).
 *
 * WHY A MANAGER, NOT "LET NPCs HEAR THE BROADCAST" (spec §4.2)
 * -----------------------------------------------------------
 * If NPC chat lines re-entered the observe/broadcast path, we'd rebuild the exact
 * self-loop F2 deliberately avoids, and with ≥2 agents reacting concurrently we'd get
 * OVERLAPPING gateway calls and out-of-order replies. So one manager serializes a
 * ROUND: it runs EXACTLY ONE agent turn at a time (one in-flight gateway call, ever),
 * round-robin across the participants, over ONE shared transcript. That gives clean
 * turn-taking, coherent ordering, bounded cost, and survives >2 agents — all in one
 * structure. `onMessage('chat')` stays human-only; rounds are seeded via a separate
 * `/seed` command channel, so NPC lines can never re-enter the human path.
 *
 * TERMINATION WITHOUT A HARD CAP (spec §4.3)
 * ------------------------------------------
 * Two LLM agents told to "converse" never converge by default (a politeness loop). So
 * a turn may signal "nothing to add" with a [PASS]. TWO CONSECUTIVE PASSES end the
 * round — that IS "the agents decided they're done". A finished round then PRODUCES a
 * decision: the last real speaker emits a concluding "Decidimos: …" line, so the
 * outcome surfaces instead of reading as banter. No hard turn cap is needed because…
 *
 * …THE SAFETY THAT REPLACES THE CAP (spec §4.5, load-bearing, ships in F4a)
 * ------------------------------------------------------------------------
 *   • Idle = zero spend: a round only runs because a human typed /seed (§4.4).
 *   • Human STOP: /stop halts the round immediately (the in-flight reply is the last).
 *   • Runaway backstop: a deliberately-high ceiling that, if hit, stops the round and
 *     logs LOUDLY as a WARNING — distinct from normal pass-termination, because hitting
 *     it means the PASS mechanism failed (a bug signal, not a feature).
 *
 * HEADLESS-TESTABLE BY CONSTRUCTION
 * ---------------------------------
 * The manager depends only on injected callbacks (broadcastChat, log), a minimal
 * `AgentBody` view (key + currentZone), and a swappable `TurnEngine`. So the whole
 * loop runs in `F4a.probe.ts` with a scripted engine — no LLM, no Colyseus, no VPN —
 * which is also the off-VPN RUNTIME path (the scripted fallback ported from F2).
 */

/** One line in the shared round transcript. `from` is an agent key or the human's id;
 *  `name` is the display name used to label the line for the model ("Seneca: …"). */
export type TranscriptEntry = { from: string; name: string; text: string };

// AgentBody (the body contract) is imported + re-exported above; it lives in tools.ts
// because the tool handlers operate on it. In F4a the manager read only key + currentZone;
// F4b adds moveToZone (the move tool's effect). Typing bodies as this interface — not the
// concrete NpcController — is what lets the probe pass cheap stubs.

/** The outcome of ONE agent turn (F4b). `text` is what the agent said (null/empty if it
 *  only acted or passed); `toolCalls` are the actions it chose (move, or yield_turn as a
 *  PASS). F4a turns simply return `{ text, toolCalls: [] }`. */
export type TurnResult = { text: string | null; toolCalls: TurnToolCall[] };
/** A tool call as the engine surfaces it: name + parsed args. (Mirror of miaGateway's
 *  ToolCall minus the id, which the manager doesn't need.) */
export type TurnToolCall = { name: string; args: Record<string, unknown> };

/** Produces ONE agent turn. `mode` is 'turn' (debate) or 'conclude' (the final decision
 *  line). Returns text (may contain the [PASS] sentinel) AND any tool calls. Two impls:
 *  a live one (calls the gateway, with tools) and a scripted one (deterministic, off-VPN
 *  + tests). Injectable so the probe can force PASS / force never-PASS / force a move. */
export type TurnEngine = (
  agent: AgentConfig,
  transcript: TranscriptEntry[],
  mode: 'turn' | 'conclude',
) => Promise<TurnResult>;

type LogFn = (level: 'info' | 'warn' | 'error', text: string) => void;
type BroadcastFn = (zone: string, from: string, text: string) => void;

type ManagerOpts = {
  roster: AgentConfig[];
  bodies: Map<string, AgentBody>;
  broadcastChat: BroadcastFn;
  log: LogFn;
  /** Override the turn source (probe/test-mode). Default: live gateway if configured,
   *  else the scripted fallback — so a round runs out-of-the-box, off-VPN. */
  turnEngine?: TurnEngine;
  /** Safety-net ceiling on turns (NOT the primary stop — consensus + human STOP are).
   *  `0` (or negative) = UNLIMITED: the round ends only on consensus or /stop. Default 30. */
  runawayCap?: number;
  /** Stop a round after this many CONSECUTIVE no-progress turns (no speech/work/pass) — a
   *  degenerate-loop guard (e.g. agents only moving) that lets PRODUCTIVE rounds run
   *  unbounded. 0 = disabled. Default 8. This is the real safety behind unlimited turns. */
  noProgressCap?: number;
  /** Pause between turns (ms) so humans can read the round + the movement shows. 0 in
   *  the probe for speed; a small value in prod. */
  turnDelayMs?: number;
  /** F4b: offer the move/yield_turn tools to the live model. Default true. (The live
   *  engine only; the scripted/injected engines ignore it.) */
  enableTools?: boolean;
  /** F5: the bridge to the harness work service. If set, agents can call `do_work` and
   *  the manager runs a sandboxed work turn. If absent, a `do_work` call degrades to a
   *  chat line (the office still works without the service). Injected so the probe stubs it. */
  workClient?: WorkClient;
  /** F5: the model id the harness uses for the work loop (e.g. "vllm/Modelo-bXs2"). */
  workModel?: string;
  /** F5: zone id → workspace path the harness writes to (the shared "repo" of that zone). */
  zoneWorkspace?: (zone: string) => string;
};

/** Tolerant pass-sentinel detection. The model signals "nothing to add" two ways that we
 *  must catch as TEXT (it doesn't always use the structured tool): `[PASS]` (F4a sentinel)
 *  and `[yield_turn]` (the F4b tool emitted as text — observed live causing a runaway when
 *  unrecognized). Matched anywhere, case-insensitively, tolerating a space in "yield turn". */
const PASS_RE = /\[\s*(?:PASS|yield[ _]?turn)\s*\]/i;
function isPassText(raw: string | null): boolean {
  return !!raw && PASS_RE.test(raw);
}
/** Strip the sentinel(s) from anything we broadcast (a PASS turn shows nothing). */
function stripPass(raw: string | null): string {
  return (raw ?? '').replace(/\[\s*(?:PASS|yield[ _]?turn)\s*\]/gi, '').trim();
}

/** Appended to a live agent's persona on a normal turn. CRITICAL convention (fixes a real
 *  bug where the model wrote "[MOVE]" / "do_work: …" / "[yield_turn]" as TEXT instead of
 *  calling the tool): actions go through the STRUCTURED tools, the text is only for talking.
 *  Kept here (not in the persona) so personas stay about identity, not protocol. */
const TURN_PROTOCOL =
  'Es tu turno. Para MOVERTE por la oficina o REALIZAR una tarea de trabajo (escribir/' +
  'ejecutar código, generar ficheros), DEBES llamar a la herramienta correspondiente ' +
  '(move / do_work). NUNCA escribas la acción como texto (nada de "[MOVE]", "do_work: ...", ' +
  '"move(...)"): el texto es SOLO para una frase de conversación con tus compañeros. ' +
  'Si no tienes nada que añadir o el tema está resuelto, llama a la herramienta yield_turn ' +
  '(o, si no, responde EXACTAMENTE [PASS]).';
/** Appended for the closing turn: force the decision line so the round produces an
 *  outcome, not silence (spec §4.3). */
const CONCLUSION_PROTOCOL =
  'El debate ha terminado. Resume la decisión del equipo en UNA sola línea que ' +
  "empiece por 'Decidimos:'.";

/** How many scripted lines each round speaks before the scripted fallback starts
 *  PASSing — so an off-VPN round converges instead of running to the cap. */
const SCRIPTED_LINES = 4;

export class ConversationManager {
  private readonly roster: AgentConfig[];
  private readonly bodies: Map<string, AgentBody>;
  private readonly broadcastChat: BroadcastFn;
  private readonly log: LogFn;
  private readonly engine: TurnEngine;
  private readonly runawayCap: number;
  private readonly noProgressCap: number;
  private readonly turnDelayMs: number;
  private readonly toolsEnabled: boolean;
  /** F5 — the work bridge + its config; absent ⇒ do_work degrades to a chat line. */
  private readonly workClient?: WorkClient;
  private readonly workModel: string;
  private readonly zoneWorkspace: (zone: string) => string;
  /** Abort handle for an in-flight work turn (so a human STOP tears it down). */
  private workAbort?: AbortController;

  /** The single in-progress round, if any. The shared transcript IS the round state. */
  private transcript: TranscriptEntry[] = [];
  private participants: AgentConfig[] = [];
  private zone = '';
  /** True while a round's async loop is alive. Guards re-entrancy: a /seed mid-round
   *  re-seeds the SAME round, it never starts a second loop (so "one in-flight" holds). */
  private running = false;
  /** Set by stop(); the loop checks it between turns and after each await. */
  private stopped = false;
  /** Resolves when the current round ends (the probe awaits this; prod ignores it). */
  private roundPromise: Promise<void> | null = null;
  /** Per-round counter for the scripted fallback (reset on seed). */
  private scriptedTurns = 0;

  constructor(opts: ManagerOpts) {
    this.roster = opts.roster;
    this.bodies = opts.bodies;
    this.broadcastChat = opts.broadcastChat;
    this.log = opts.log;
    // 0/negative → unlimited (Infinity): rely on consensus + human STOP, no turn ceiling.
    const cap = opts.runawayCap ?? 30;
    this.runawayCap = cap <= 0 ? Infinity : cap;
    this.noProgressCap = opts.noProgressCap ?? 8;
    this.turnDelayMs = opts.turnDelayMs ?? 0;
    this.toolsEnabled = opts.enableTools ?? true;
    this.workClient = opts.workClient;
    this.workModel = opts.workModel ?? '';
    this.zoneWorkspace = opts.zoneWorkspace ?? ((zone) => `/tmp/office-ws/${zone}`);
    // Pick the turn source ONCE: an explicit override (probe/test) wins; otherwise the
    // live gateway if it's configured, else the scripted fallback (off-VPN runtime).
    this.engine =
      opts.turnEngine ?? (gatewayConfigured() ? this.liveEngine : this.scriptedEngine);
  }

  /** True while a round is in progress. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Resolve once the current round (if any) has fully ended. */
  settled(): Promise<void> {
    return this.roundPromise ?? Promise.resolve();
  }

  /**
   * A human seeds/addresses a topic (via /seed). If a round is already running this is
   * a RE-SEED (spec §4.4): inject the new line into the shared transcript and let the
   * round continue with that context — never start a second loop. Otherwise start a
   * round, but only if ≥2 agents share the seed zone (else the NPC↔NPC demo can't fire
   * — we log and do nothing rather than silently no-op).
   *
   * @param fromId the human's state id (sessionId), so the echoed seed is stamped as
   *   theirs and the client marks it "you". @param humanName the display name (or '').
   */
  seed(zone: string, topic: string, fromId: string, humanName?: string): void {
    const text = topic.trim();
    if (!text) return;

    // Re-seed an in-progress round: append + echo, then let the loop pick it up.
    if (this.running) {
      this.transcript.push({ from: fromId, name: humanName || 'Colega', text });
      this.broadcastChat(this.zone, fromId, text);
      this.log('info', `🌱 re-seed mid-round: "${text.slice(0, 60)}"`);
      return;
    }

    // Participants = roster agents currently in the seed zone (zone-scoped delivery
    // means only co-zoned agents can actually hear each other — plan §3b).
    const participants = this.roster.filter((a) => this.bodies.get(a.key)?.currentZone === zone);
    if (participants.length < 2) {
      this.log('warn', `🌱 seed ignorado: <2 agentes en la zona "${zone}" (${participants.length})`);
      return;
    }

    // Start the round. The seed is echoed to the zone (so the human sees what they
    // seeded) AND is the first transcript line (so agents have the topic as context).
    this.zone = zone;
    this.participants = participants;
    this.transcript = [{ from: fromId, name: humanName || 'Colega', text }];
    this.scriptedTurns = 0;
    this.stopped = false;
    this.running = true;
    this.broadcastChat(zone, fromId, text);
    this.log('info', `🌱 ronda sembrada en "${zone}" con ${participants.length} agentes: "${text.slice(0, 60)}"`);

    // Fire-and-forget the async loop; settled()/the finally reset the running state.
    this.roundPromise = this.runRound()
      .catch((err) => this.log('error', `conversación: ${(err as Error).message}`))
      .finally(() => {
        // Round over (any path: consensus, STOP, runaway, or an error) → snap the
        // agents back to their home zone, so a move-heavy round doesn't strand them and
        // the NEXT /seed has quorum. (Found in F4b E2E: a 2nd seed found 0 agents — the
        // move tool had permanently relocated them.) Done HERE in the shared finally so
        // it can't be skipped by an early return inside runRound.
        this.returnParticipantsHome();
        this.running = false;
        this.roundPromise = null;
      });
  }

  /** Snap every participant of the round just ended back to its roster home zone. Idle
   *  between rounds, the office reconvenes at the hub (lobby), so seeding works again. */
  private returnParticipantsHome(): void {
    for (const agent of this.participants) {
      const body = this.bodies.get(agent.key);
      if (body && body.currentZone !== agent.homeZone) body.returnHome();
    }
  }

  /** Human STOP: halt the round immediately. The loop checks `stopped` after each await,
   *  so the in-flight reply (if any) is the last; no further turns are issued (spec §4.5). */
  stop(): void {
    if (!this.running) return;
    this.stopped = true;
    this.workAbort?.abort(); // tear down an in-flight work turn (F5)
    this.log('info', '⏹ STOP: ronda detenida por un humano');
  }

  /**
   * The round loop — the spine. ONE turn at a time, round-robin, until: two consecutive
   * passes (consensus), the runaway cap (bug backstop), or STOP. Because every turn is
   * `await`ed before the next starts, only one gateway call is ever in flight.
   */
  private async runRound(): Promise<void> {
    const roundStart = Date.now();
    let consecutivePasses = 0;
    let turnIndex = 0;
    let lastSpeaker: AgentConfig | null = null;
    // Consecutive turns with NO progress (no speech, no work, no pass) — a degenerate loop
    // signal (e.g. agents just moving back and forth). This, not a turn count, is the real
    // safety: productive rounds run unbounded; a stuck round is caught. `stuck` skips the
    // consensus conclusion when we break for this reason.
    let noProgress = 0;
    let stuck = false;

    while (!this.stopped && consecutivePasses < 2 && turnIndex < this.runawayCap) {
      const agent = this.participants[turnIndex % this.participants.length];
      const t0 = Date.now();
      const result = await this.engine(agent, this.transcript, 'turn');
      turnIndex++;
      const roundMs = Date.now() - roundStart;

      // F5 — if the agent decided to DO work, this turn IS the work turn: delegate the
      // goal to the harness (a sandboxed ReAct loop), stream its tool-calls to the log,
      // and the work summary becomes the agent's spoken line. Doing work is a real
      // contribution, so it resets the pass streak. (Handled before the F4b sync tools.)
      const workCall = result.toolCalls.find((c) => c.name === DO_WORK);
      if (workCall) {
        consecutivePasses = 0;
        noProgress = 0; // doing work IS progress
        await this.runWorkTurn(agent, String(workCall.args.goal ?? ''), turnIndex);
        lastSpeaker = agent;
        if (this.stopped) break;
        if (this.turnDelayMs > 0) await delay(this.turnDelayMs);
        continue;
      }

      // F4b — a turn may carry tool calls. `yield_turn` is a PASS SIGNAL (not executed);
      // every other call (move) runs single-step against the world, server-side.
      let yielded = false;
      let acted = false;
      for (const call of result.toolCalls) {
        if (call.name === YIELD_TURN) {
          yielded = true;
          continue;
        }
        const out = executeToolCall({ id: '', name: call.name, args: call.args }, this.toolContext(agent.key));
        acted = acted || out.ok;
        this.log(out.ok ? 'info' : 'warn', `🔧 turn ${turnIndex} · ${agent.name} · ${call.name} ${out.note}`);
      }

      const text = stripPass(result.text);
      const sentinelPass = isPassText(result.text);
      // A PASS is: an explicit yield_turn, OR the [PASS] sentinel with no action, OR an
      // utterly empty turn (no text, no tool calls). A move (acted) or any speech breaks
      // the streak — it's a real contribution, not "nothing to add".
      const passed =
        yielded ||
        (sentinelPass && !acted) ||
        (!text && !acted && result.toolCalls.length === 0);

      if (passed) {
        consecutivePasses++;
        noProgress = 0; // a pass is a deliberate signal toward consensus, not churn
        this.log('info', `🔁 turn ${turnIndex} · ${agent.name} · PASS · round Σ ${(roundMs / 1000).toFixed(1)}s`);
      } else {
        consecutivePasses = 0;
        if (text) {
          this.transcript.push({ from: agent.key, name: agent.name, text });
          this.broadcastChat(this.zone, agent.key, text);
          lastSpeaker = agent;
          noProgress = 0; // a real conversational contribution
        } else {
          // move-only or empty turn: nothing said, nothing worked — no progress this turn.
          noProgress++;
        }
        this.log('info', `🔁 turn ${turnIndex} · ${agent.name} · ${Date.now() - t0}ms${acted ? ' · 🚶 move' : ''} · round Σ ${(roundMs / 1000).toFixed(1)}s`);
      }

      // No-progress backstop: makes UNLIMITED turns safe. A round that churns for
      // noProgressCap turns with no speech/work/pass is a degenerate loop → stop it.
      // Productive rounds reset the counter every turn, so they run unbounded.
      if (this.noProgressCap > 0 && noProgress >= this.noProgressCap) {
        this.log('warn', `⚠️ ronda detenida: ${noProgress} turnos sin progreso (ni texto ni trabajo) — posible bucle`);
        stuck = true;
        break;
      }

      // STOP may have been requested during the await (the in-flight line above was the
      // last). Break BEFORE issuing another turn.
      if (this.stopped) break;
      if (this.turnDelayMs > 0) await delay(this.turnDelayMs);
    }

    // ── Termination reason ──────────────────────────────────────────────────────
    if (this.stopped) return; // already logged by stop()
    if (stuck) return; // no-progress backstop already logged; a stuck round has no consensus

    if (turnIndex >= this.runawayCap) {
      // The PASS mechanism never fired — this is a BUG SIGNAL, logged loudly and
      // distinctly from a normal pass-termination (spec §4.5).
      this.log('warn', `⚠️ RUNAWAY backstop: ronda detenida tras ${turnIndex} turnos sin consenso (el mecanismo PASS falló — revisar)`);
      return;
    }

    // Consensus: the agents passed. Produce the decision line (spec §4.3) from the last
    // agent that actually spoke — after two passes, that's the last NON-pass speaker.
    if (lastSpeaker) {
      const result = await this.engine(lastSpeaker, this.transcript, 'conclude');
      const line = stripPass(result.text);
      if (line) {
        this.transcript.push({ from: lastSpeaker.key, name: lastSpeaker.name, text: line });
        this.broadcastChat(this.zone, lastSpeaker.key, line);
      }
    }
    this.log('info', `✅ consenso tras ${turnIndex} turnos · round Σ ${((Date.now() - roundStart) / 1000).toFixed(1)}s`);
  }

  /** Build the context a tool handler needs: who is acting + the body map (so `move`
   *  can resolve "toward:<agentKey>" and call moveToZone on the right body). */
  private toolContext(agentKey: string): ToolContext {
    return { agentKey, bodies: this.bodies };
  }

  /**
   * F5 — run ONE work turn: the agent's `do_work(goal)` is delegated to the harness work
   * service (a sandboxed ReAct loop). Each executed sandbox tool streams to the server-log
   * as it happens; the final summary becomes the agent's spoken line (and joins the
   * transcript, so the next turn can discuss the result). If the service is absent or
   * unreachable, we DEGRADE to a chat line (spec R6) — the round never crashes.
   */
  private async runWorkTurn(agent: AgentConfig, goal: string, turnIndex: number): Promise<void> {
    this.log('info', `🛠 turn ${turnIndex} · ${agent.name} se pone a trabajar: "${goal.slice(0, 60)}"`);
    if (!this.workClient) {
      this.broadcastChat(this.zone, agent.key, 'Quería ponerme a trabajar, pero no hay servicio de trabajo configurado.');
      return;
    }
    this.workAbort = new AbortController();
    const res = await this.workClient(
      { agentKey: agent.key, goal, workspace: this.zoneWorkspace(this.zone), model: this.workModel },
      (e) => {
        if (e.kind === 'tool') this.log('info', `   🔧 ${e.name}: ${e.output.replace(/\s+/g, ' ').slice(0, 120)}`);
        else if (e.kind === 'error') this.log('warn', `   ⚠️ trabajo: ${e.message}`);
      },
      this.workAbort.signal,
    );
    this.workAbort = undefined;

    if (!res) {
      // Transport failure / aborted / no result → degrade, keep the round alive (R6).
      this.broadcastChat(this.zone, agent.key, 'No he podido completar el trabajo ahora mismo.');
      return;
    }
    let line = res.summary.trim();
    // STRUCTURED signal (not text-grepping): if the work hit the step cap (didn't finish)
    // or produced no summary, surface a graceful line that still shows any files produced.
    if (res.stopReason === 'max_steps' || !line) {
      const files = res.files.length ? ` (ficheros: ${res.files.join(', ')})` : '';
      line = `He avanzado en la tarea${files}, pero no la he terminado del todo.`;
    }
    this.transcript.push({ from: agent.key, name: agent.name, text: line });
    this.broadcastChat(this.zone, agent.key, line);
  }

  /** LIVE turn: the gateway IS the brain. System = persona + the turn/conclusion
   *  protocol; the shared transcript follows as name-labelled 'user' lines (so the
   *  model sees "Seneca: …", "Marcus: …" and continues as itself). Mirrors F2's shape.
   *
   *  GRACEFUL DEGRADATION (ported from F2's observeChat): the gateway can be CONFIGURED
   *  but unreachable (e.g. a dev off the UAB VPN). A blip must not abort the round, so we
   *  fall back to the scripted turn — which both keeps the agent talking AND, because the
   *  scripted path PASSes after a few lines, lets a fully-down round still CONVERGE
   *  instead of running to the runaway cap. */
  private liveEngine: TurnEngine = async (agent, transcript, mode) => {
    const protocol = mode === 'conclude' ? CONCLUSION_PROTOCOL : TURN_PROTOCOL;
    const messages: ChatMessage[] = [
      { role: 'system', content: `${agent.persona}\n\n${protocol}` },
      ...transcript.map((e): ChatMessage => ({ role: 'user', content: `${e.name || 'Colega'}: ${e.text}` })),
    ];
    try {
      // F4b — offer tools only on a NORMAL turn; a conclusion is pure text (we want a
      // decision line, not an action). The model may answer with text, tool calls, or both.
      const reply = await gatewayChat(messages, this.toolsEnabled && mode === 'turn' ? { tools: TOOL_DEFS } : undefined);
      return { text: reply.content, toolCalls: reply.toolCalls.map((c) => ({ name: c.name, args: c.args })) };
    } catch (err) {
      this.log('warn', `⚠️ gateway falló → turno scripted: ${(err as Error).message}`);
      return this.scriptedEngine(agent, transcript, mode);
    }
  };

  /** SCRIPTED turn (off-VPN runtime + the deterministic test path). Speaks a canned
   *  line for the first SCRIPTED_LINES turns, then PASSes so the round converges; the
   *  conclusion is a fixed decision line. Keeps the repo working with zero external
   *  setup, exactly like F2's scriptedReply (relocated here, not deleted). The scripted
   *  path never emits tool calls (no actions), so toolCalls is always empty. */
  private scriptedEngine: TurnEngine = (agent, _transcript, mode) => {
    if (mode === 'conclude') return Promise.resolve({ text: 'Decidimos: lo dejamos aquí por ahora.', toolCalls: [] });
    this.scriptedTurns++;
    const text =
      this.scriptedTurns <= SCRIPTED_LINES
        ? `${agent.name}: aporto mi punto de vista (${this.scriptedTurns}).`
        : '[PASS]';
    return Promise.resolve({ text, toolCalls: [] });
  };
}

/** Resolve after `ms`. Used between turns for readability; isolated so the loop reads cleanly. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
