import http from 'node:http';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  workClient — the bridge to the predicta-harness work service (F5)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * When an agent decides to DO work (the `do_work` tool), the ConversationManager calls
 * this to run the goal as a sandboxed ReAct loop in the Python harness. We POST the goal
 * and read back an SSE stream: one `tool` event per executed sandbox tool (so the manager
 * can stream live progress to the `server-log`), then a final `done` with the summary +
 * the files produced. A transport failure resolves to `null` so the manager can DEGRADE
 * to a plain chat line (spec R6) instead of crashing the round.
 *
 * Why a thin node:http client (not fetch): we want to parse the event stream INCREMENTALLY
 * as chunks arrive (so tool events surface live), and pass an AbortSignal so a human STOP
 * can tear the request down. node:http gives us both with no dependency.
 */

export type WorkEvent =
  | { kind: 'tool'; name: string; input: unknown; output: string }
  | { kind: 'done'; summary: string; files: string[]; steps: number }
  | { kind: 'error'; message: string };

export type WorkRequest = { agentKey: string; goal: string; workspace: string; model: string };

/** Resolves with the final result, or `null` on transport failure (→ the manager degrades). */
export type WorkClient = (
  req: WorkRequest,
  onEvent: (e: WorkEvent) => void,
  signal?: AbortSignal,
) => Promise<{ summary: string; files: string[] } | null>;

/** Build a WorkClient pointed at the harness base URL (e.g. http://127.0.0.1:8088). */
export function makeWorkClient(baseUrl: string): WorkClient {
  return (req, onEvent, signal) =>
    new Promise((resolve) => {
      const url = new URL('/work', baseUrl);
      const payload = JSON.stringify(req);
      let done: { summary: string; files: string[] } | null = null;
      let buf = '';

      const request = http.request(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          signal,
        },
        (res) => {
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            buf += chunk;
            // Emit each COMPLETE SSE block (blocks are separated by a blank line). A partial
            // tail stays buffered until the rest of its bytes arrive.
            let sep: number;
            while ((sep = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              const ev = parseBlock(block);
              if (!ev) continue;
              if (ev.kind === 'done') done = { summary: ev.summary, files: ev.files };
              onEvent(ev);
            }
          });
          res.on('end', () => resolve(done));
        },
      );
      // Transport failure OR abort (human STOP): resolve with whatever we had (null if the
      // service never answered) so the round degrades / continues — never throws.
      request.on('error', () => resolve(done));
      request.write(payload);
      request.end();
    });
}

/** Parse one `event: <x>\ndata: <json>` SSE block into a typed WorkEvent (null if malformed). */
function parseBlock(block: string): WorkEvent | null {
  let event = '';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) data = line.slice('data:'.length).trim();
  }
  if (!event || !data) return null;
  try {
    const d = JSON.parse(data);
    if (event === 'tool') return { kind: 'tool', name: d.name, input: d.input, output: String(d.output ?? '') };
    if (event === 'done') return { kind: 'done', summary: d.summary ?? '', files: d.files ?? [], steps: d.steps ?? 0 };
    if (event === 'error') return { kind: 'error', message: d.message ?? 'unknown error' };
  } catch {
    /* ignore a malformed block */
  }
  return null;
}
