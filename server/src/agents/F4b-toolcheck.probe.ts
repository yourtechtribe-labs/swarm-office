/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  F4b-toolcheck.probe — verify the gateway returns tool_calls in OpenAI shape
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (spec §6 pre-req, plan §4 gate)
 * ----------------------------------------------
 * F4b's `move` tool depends on the vLLM build returning function calls in the
 * STANDARD OpenAI shape: `choices[0].message.tool_calls[]` with `{ id, type:'function',
 * function:{ name, arguments(JSON string) } }` and `finish_reason:'tool_calls'`. Some
 * self-hosted builds don't, or emit a non-standard variant. Before writing the F4b
 * parser against an assumed shape, we send ONE real request WITH a `tools` array and
 * DUMP the raw message so we can eyeball it. This is a manual gate, run on the UAB VPN.
 *
 * Run: `cd server && npx tsx src/agents/F4b-toolcheck.probe.ts`
 * (Reads server/.env directly — this probe is standalone, not booted via index.ts.)
 */

import https from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ── Load server/.env into process.env (minimal parser; the probe runs standalone) ──
const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, '../../.env'); // server/.env
try {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  console.error(`⚠️ could not read ${envPath}`);
}

const base = process.env.MIA_GATEWAY_URL?.trim();
const auth = process.env.MIA_GATEWAY_AUTH?.trim();
const model = process.env.MIA_GATEWAY_MODEL?.trim();
const insecure = process.env.MIA_GATEWAY_INSECURE_TLS === 'true';
if (!base || !auth || !model) {
  console.error('❌ gateway not configured (MIA_GATEWAY_URL/AUTH/MODEL). Run on the UAB VPN with server/.env set.');
  process.exit(1);
}

// A trivial move tool, OpenAI function-calling shape.
const tools = [
  {
    type: 'function',
    function: {
      name: 'move',
      description: 'Mueve al agente hacia una zona de la oficina.',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string', description: 'id de zona, p.ej. "lobby"' } },
        required: ['target'],
      },
    },
  },
];

const payload = JSON.stringify({
  model,
  messages: [
    { role: 'system', content: 'Eres un agente en una oficina. Cuando te pidan moverte, USA la herramienta move.' },
    { role: 'user', content: 'Por favor, muévete a la zona lobby.' },
  ],
  tools,
  tool_choice: 'auto',
  max_tokens: 160,
  temperature: 0.2,
  chat_template_kwargs: { enable_thinking: false },
});

const url = new URL(`${base.replace(/\/$/, '')}/chat/completions`);
const agent = insecure ? new https.Agent({ rejectUnauthorized: false }) : undefined;

console.log(`F4b toolcheck → ${url.host} · model=${model} · insecureTLS=${insecure}`);

const req = https.request(
  url,
  {
    method: 'POST',
    agent,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: auth },
  },
  (res) => {
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (raw += c));
    res.on('end', () => {
      console.log(`HTTP ${res.statusCode}`);
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        console.log('non-JSON body:', raw.slice(0, 500));
        process.exit(2);
      }
      const choice = (body as { choices?: Array<{ finish_reason?: string; message?: unknown }> })?.choices?.[0];
      console.log('finish_reason:', choice?.finish_reason);
      console.log('message:', JSON.stringify(choice?.message, null, 2));
      // Verdict on the shape F4b will parse against.
      const msg = choice?.message as { content?: string; tool_calls?: unknown[] } | undefined;
      const tc = msg?.tool_calls;
      if (Array.isArray(tc) && tc.length > 0) {
        console.log(`\n✅ tool_calls present (${tc.length}). Standard OpenAI shape → F4b parser can target choices[0].message.tool_calls.`);
        console.log('first tool_call:', JSON.stringify(tc[0], null, 2));
      } else {
        console.log('\n⚠️ NO tool_calls in the response. The model answered in content instead:');
        console.log('content:', msg?.content?.slice(0, 300));
        console.log('→ F4b must NOT assume tool_calls on this build; fall back to a text-command convention or adjust the request.');
      }
    });
  },
);
req.setTimeout(12000, () => req.destroy(new Error('timeout 12s — off VPN?')));
req.on('error', (e) => {
  console.error('❌ request failed:', e.message, '\n(likely off the UAB VPN, or TLS/endpoint changed.)');
  process.exit(3);
});
req.write(payload);
req.end();
