import config, { listen } from '@colyseus/tools';
import cors from 'cors';
import type { Request, Response } from 'express';
import { OfficeRoom } from './rooms/OfficeRoom';

// Load server-side config (the optional M.IA gateway — F2b) from a local .env, the
// zero-dependency Node 22 way (`process.loadEnvFile`, no `dotenv` package). The file
// is gitignored and holds the gateway URL/key, which must NEVER reach the client.
// Wrapped in try/catch: no .env is the normal case (NPC falls back to scripted
// replies), not an error. Done before listen() so env is set before the first chat.
try {
  process.loadEnvFile();
} catch {
  /* no .env present — fine; the gateway just stays unconfigured */
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  Server entrypoint
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * @colyseus/tools `listen()` wires up the whole stack the right way: the WebSocket
 * transport, the matchmaking HTTP routes, an Express app for our own routes, and
 * graceful shutdown. We only fill in two hooks.
 *
 * THE CORS GOTCHA (why this matters)
 * ----------------------------------
 * `client.joinOrCreate("office")` is NOT purely a WebSocket call. The SDK first
 * does an HTTP POST to /matchmake/... to reserve a seat, THEN upgrades to a
 * WebSocket. That HTTP POST is cross-origin (client on :5173, server on :2567), so
 * the browser enforces CORS on it. Without the cors() middleware below the call
 * fails with a generic "can't connect" — a deceptive error that looks like the
 * server is down. cors() with no options allows any origin (fine for local dev;
 * tighten to the real origin before deploy).
 */
const PORT = Number(process.env.PORT) || 2567;

// `config()` (the @colyseus/tools default export) wraps our hooks and fills the
// internal registries that `listen()` requires; passing a bare object literal
// fails to type-check (missing '~rooms'/'~routes').
listen(
  config({
    initializeGameServer: (gameServer) => {
      // Register the room under the name the client joins by ("office").
      gameServer.define('office', OfficeRoom);
    },

    initializeExpress: (app) => {
      app.use(cors()); // allow the cross-origin matchmaking POST from the dev client
      app.get('/health', (_req: Request, res: Response) => {
        res.json({ ok: true });
      });
    },

    beforeListen: () => {
      console.log(`[swarm-office] server listening on :${PORT}`);
    },
  }),
  PORT,
);
