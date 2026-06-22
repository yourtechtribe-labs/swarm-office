import https from 'node:https';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  miaGateway — the NPC's "brain" (F2b): an OpenAI-compatible chat completion
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS IS
 * ------------
 * A thin, server-side client for an OpenAI-compatible chat-completions endpoint
 * (the "M.IA gateway"). F2a proved the whole NPC loop with a scripted reply; F2b
 * swaps ONLY the reply source for this — the hearing, zone scoping, cooldown and
 * broadcast in NpcController/OfficeRoom are unchanged.
 *
 * OPTIONAL BY DESIGN
 * ------------------
 * The gateway is configured purely via env (see `.env.example`). If it isn't set,
 * `gatewayConfigured()` returns false and the NPC falls back to scripted replies —
 * so this open-source repo runs out of the box, and a dev off the gateway's network
 * still gets a working NPC. The API KEY lives ONLY here on the server and never
 * reaches the client (spec §6 — identity stays server-controlled).
 *
 * WHY node:https AND NOT fetch (the TLS gotcha)
 * ---------------------------------------------
 * The target endpoint (a self-hosted vLLM behind an internal reverse proxy) serves
 * a TLS cert that does NOT validate the hostname, so a normal client rejects it.
 * Node's global `fetch` (undici) can only skip that with a custom `dispatcher`, which
 * needs the `undici` package (not installed — and we keep deps minimal + pinned).
 * `node:https` is built in and lets us scope `rejectUnauthorized:false` to THIS one
 * Agent (never the whole process — `NODE_TLS_REJECT_UNAUTHORIZED=0` would disable
 * TLS validation everywhere, the opposite of this repo's hardening stance). The
 * insecure bypass is itself opt-in via `MIA_GATEWAY_INSECURE_TLS=true`, default off.
 */

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** An OpenAI-shaped function/tool definition we pass to the gateway (F4b). The model
 *  may answer by CALLING one of these instead of (or alongside) plain text. */
export type ToolDef = {
  type: 'function';
  function: { name: string; description: string; parameters: object };
};

/** A tool call the model decided to make, already PARSED for the caller: the gateway
 *  returns `function.arguments` as a JSON STRING (verified on this vLLM build, F4b
 *  toolcheck), so we parse it here into an object and hand back `{ id, name, args }`. */
export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

/** A full gateway reply (F4b). `content` is the assistant's text (can be `null` on a
 *  pure tool-call turn — confirmed live); `toolCalls` is empty unless the model called
 *  a tool. F4a's `gatewayComplete` is a thin wrapper that needs only `content`. */
export type GatewayReply = { content: string | null; toolCalls: ToolCall[] };

/** Hard cap on the reply length (tokens). A chat NPC says a line, not an essay —
 *  and this bounds latency + cost per call (spec §6). */
const MAX_TOKENS = 160;
/** Request timeout (ms). Verified endpoint latency is 0.4–3.6s, so this is generous
 *  headroom — but short enough that if the endpoint is unreachable (e.g. dev off the
 *  network) the NPC falls back to a scripted line in ~8s, not after a long hang. */
const TIMEOUT_MS = 8000;
/** Sampling temperature — a little warmth/variation without going off the rails. */
const TEMPERATURE = 0.7;

type GatewayConfig = { base: string; auth: string; model: string; insecure: boolean };

// Resolved once, lazily, then cached (env doesn't change at runtime). `undefined` =
// not yet read; `null` = read and NOT configured; object = configured.
let cached: GatewayConfig | null | undefined;

function readConfig(): GatewayConfig | null {
  if (cached !== undefined) return cached;
  const base = process.env.MIA_GATEWAY_URL?.trim();
  const auth = process.env.MIA_GATEWAY_AUTH?.trim(); // full Authorization header value
  const model = process.env.MIA_GATEWAY_MODEL?.trim();
  cached = base && auth && model
    ? { base, auth, model, insecure: process.env.MIA_GATEWAY_INSECURE_TLS === 'true' }
    : null;
  return cached;
}

/** True when URL + auth + model are all set — i.e. the NPC can use a real brain. */
export function gatewayConfigured(): boolean {
  return readConfig() !== null;
}

/** A reusable Agent that skips cert validation, created only if the insecure flag is
 *  on. Lazily built so the secure default path never constructs an insecure Agent. */
let insecureAgent: https.Agent | undefined;
function agentFor(cfg: GatewayConfig): https.Agent | undefined {
  if (!cfg.insecure) return undefined; // use Node's default (validating) Agent
  return (insecureAgent ??= new https.Agent({ rejectUnauthorized: false, keepAlive: true }));
}

/**
 * Send `messages` to the gateway and resolve with the assistant's reply text.
 * Rejects on timeout, network error, non-2xx, or an unparseable/empty body — the
 * caller (NpcController) catches and falls back to a scripted line, so a gateway
 * blip degrades gracefully instead of muting the NPC.
 *
 * `enable_thinking:false` (vLLM/Qwen chat-template arg) turns OFF the model's
 * chain-of-thought: without it Qwen3 returns its reasoning in a separate field and
 * adds latency — for a one-line NPC we want only the final answer.
 */
export function gatewayChat(
  messages: ChatMessage[],
  opts?: { tools?: ToolDef[] },
): Promise<GatewayReply> {
  const cfg = readConfig();
  if (!cfg) return Promise.reject(new Error('gateway not configured'));

  const url = new URL(`${cfg.base.replace(/\/$/, '')}/chat/completions`);
  const payload = JSON.stringify({
    model: cfg.model,
    messages,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    chat_template_kwargs: { enable_thinking: false },
    // Only send the tools fields when tools are provided, so F4a's plain text turns
    // hit the exact same request shape they always did (no behaviour drift).
    ...(opts?.tools?.length ? { tools: opts.tools, tool_choice: 'auto' } : {}),
  });

  return new Promise<GatewayReply>((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        agent: agentFor(cfg),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: cfg.auth,
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`gateway HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
            return;
          }
          try {
            const message = JSON.parse(raw)?.choices?.[0]?.message;
            const content = typeof message?.content === 'string' ? message.content.trim() : null;
            // Parse tool_calls into {id,name,args}. arguments is a JSON STRING on this
            // build (verified by F4b-toolcheck); a malformed one degrades to {} rather
            // than throwing the whole turn away.
            const toolCalls: ToolCall[] = Array.isArray(message?.tool_calls)
              ? message.tool_calls.map((tc: { id?: string; function?: { name?: string; arguments?: string } }) => ({
                  id: tc.id ?? '',
                  name: tc.function?.name ?? '',
                  args: safeParseArgs(tc.function?.arguments),
                }))
              : [];
            // A valid turn must carry SOMETHING — text or a tool call. (A pure tool
            // turn legitimately has content:null, so we can't require content alone.)
            if (!content && toolCalls.length === 0) {
              reject(new Error('gateway returned empty content and no tool_calls'));
              return;
            }
            resolve({ content: content || null, toolCalls });
          } catch (e) {
            reject(new Error(`gateway bad JSON: ${(e as Error).message}`));
          }
        });
      },
    );
    // Reject (and tear the socket down) if the endpoint is slow/unreachable, so the
    // caller's fallback fires promptly instead of the request hanging open.
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`gateway timeout ${TIMEOUT_MS}ms`)));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** F4a convenience: a plain text completion. Wraps gatewayChat and returns the text,
 *  rejecting if the model produced none (the F4a turn path always wants a line). */
export function gatewayComplete(messages: ChatMessage[]): Promise<string> {
  return gatewayChat(messages).then((reply) => {
    if (!reply.content) throw new Error('gateway returned empty content');
    return reply.content;
  });
}

/** Parse a tool_call `arguments` JSON string into an object; never throw (a bad blob
 *  becomes `{}`, and the tool handler validates the shape before acting). */
function safeParseArgs(argsJson: string | undefined): Record<string, unknown> {
  if (!argsJson) return {};
  try {
    const parsed = JSON.parse(argsJson);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
