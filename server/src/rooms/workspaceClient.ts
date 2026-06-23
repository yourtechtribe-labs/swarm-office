import http from 'node:http';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  workspaceClient — read-only browsing of a zone's workspace (F6)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Sibling of workClient (F5): where that one POSTs a goal and streams a ReAct loop, this
 * one does two plain GETs against the SAME harness service to back the file-explorer panel:
 *   • list(workspace)        → GET /files  → { files: [...] }
 *   • read(workspace, path)  → GET /file   → { path, content, truncated }
 *
 * The OfficeRoom proxies these so the browser never talks to the harness directly (it may
 * live on another host; and the office is what knows zone→workspace). Read-only: there is
 * deliberately no write/delete here — the UI can only look.
 *
 * Errors never throw: the harness returns a JSON `{ error }` body for 4xx (which we pass
 * through), and a transport failure (harness down) resolves to `{ error }` too — so the
 * room can forward a clean error to the panel instead of crashing.
 */

export type WorkspaceList = { files: string[] } | { error: string };
export type WorkspaceFile = { path: string; content: string; truncated: boolean } | { error: string };

export type WorkspaceClient = {
  list(workspace: string): Promise<WorkspaceList>;
  read(workspace: string, path: string): Promise<WorkspaceFile>;
};

export function makeWorkspaceClient(baseUrl: string): WorkspaceClient {
  // One GET → parsed JSON. The harness always answers JSON (200 or 4xx {error}); a
  // non-JSON body or a dropped connection becomes an { error } so callers have one shape.
  function get(pathAndQuery: string): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const url = new URL(pathAndQuery, baseUrl);
      const req = http.request(url, { method: 'GET' }, (res) => {
        let buf = '';
        res.on('data', (chunk) => (buf += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            resolve({ error: `respuesta no-JSON del harness (HTTP ${res.statusCode})` });
          }
        });
      });
      req.on('error', (e) => resolve({ error: `harness no disponible: ${e.message}` }));
      req.end();
    });
  }

  return {
    list: (workspace) => get(`/files?workspace=${encodeURIComponent(workspace)}`) as Promise<WorkspaceList>,
    read: (workspace, path) =>
      get(`/file?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(path)}`) as Promise<WorkspaceFile>,
  };
}
