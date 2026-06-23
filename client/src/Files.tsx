import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { EventBus } from './game/EventBus';
import './Files.css';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  Files — the workspace EXPLORER (F6): the office's "codebase", live
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The AI agents build real files in their per-zone workspace (F5 `do_work`). This surfaces
 * that as a top-right MENU (next to "Join voice"): a dropdown of the current zone's files,
 * and clicking one opens a big POPUP that renders Markdown FORMATTED (code files show raw).
 *
 * DATA FLOW (same seam as ServerLog — never touches the room directly)
 * -------------------------------------------------------------------
 * We talk only to the EventBus. `ws-request` goes React → scene → room → harness; the
 * replies (`ws-files`, `ws-file`) and the change push (`ws-changed`) come back the other
 * way. The office proxies to the harness, so the browser never sees it. Live refresh is a
 * PUSH (`ws-changed` after a work turn), not a poll. Read-only: the panel only looks.
 */
type Viewed = { content: string; truncated: boolean };

export function Files() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // The file currently open in the popup (null = popup closed) + its loaded content.
  const [modalPath, setModalPath] = useState<string | null>(null);
  const [view, setView] = useState<Viewed | null>(null);
  // modalPathRef lets the (stable) ws-file listener match the reply to the open file
  // without re-subscribing each time the selection changes.
  const modalPathRef = useRef<string | null>(null);
  modalPathRef.current = modalPath;

  const requestList = () => EventBus.emit('ws-request', { action: 'list' });

  useEffect(() => {
    const onFiles = (msg: { files: string[] } | { error: string }) => {
      if ('error' in msg) setError(msg.error);
      else {
        setError(null);
        setFiles(msg.files);
      }
    };
    const onFile = (msg: { path: string; content: string; truncated: boolean } | { error: string }) => {
      if ('error' in msg) setError(msg.error);
      // Only adopt a reply for the file the popup is actually showing (ignore stale ones).
      else if (msg.path === modalPathRef.current) setView({ content: msg.content, truncated: msg.truncated });
    };
    // A work turn changed files → re-list so the dropdown + count badge stay live.
    const onChanged = () => requestList();
    EventBus.on('ws-files', onFiles);
    EventBus.on('ws-file', onFile);
    EventBus.on('ws-changed', onChanged);
    requestList(); // initial (also re-fired by the scene once the room connects)
    return () => {
      EventBus.off('ws-files', onFiles);
      EventBus.off('ws-file', onFile);
      EventBus.off('ws-changed', onChanged);
    };
  }, []);

  const openFile = (path: string) => {
    setModalPath(path);
    setView(null); // show "cargando…" until ws-file arrives
    setMenuOpen(false); // collapse the dropdown; the popup takes over
    EventBus.emit('ws-request', { action: 'read', path });
  };

  const isMarkdown = modalPath?.toLowerCase().endsWith('.md') ?? false;

  return (
    <>
      <div className="wsmenu">
        <button className="wsmenu__btn" onClick={() => setMenuOpen((o) => !o)} aria-label="Workspace files">
          <span>📁 workspace</span>
          <span className="wsmenu__count">{files.length}</span>
          <span className="wsmenu__chevron">{menuOpen ? '▾' : '▸'}</span>
        </button>
        {menuOpen && (
          <div className="wsmenu__drop">
            {error && <div className="wsmenu__error">⚠️ {error}</div>}
            {!error && files.length === 0 && <div className="wsmenu__empty">workspace vacío</div>}
            {files.map((f) => (
              <button key={f} className="wsmenu__item" onClick={() => openFile(f)} title={f}>
                {f}
              </button>
            ))}
          </div>
        )}
      </div>

      {modalPath && (
        // Overlay: click outside the card closes it; the card stops propagation.
        <div className="wsmodal" onClick={() => setModalPath(null)}>
          <div className="wsmodal__card" onClick={(e) => e.stopPropagation()}>
            <div className="wsmodal__head">
              <span className="wsmodal__title">{modalPath}</span>
              {view?.truncated && <span className="wsmodal__trunc">truncado</span>}
              <button className="wsmodal__close" onClick={() => setModalPath(null)} aria-label="Cerrar">
                ✕
              </button>
            </div>
            <div className="wsmodal__body">
              {view === null ? (
                <div className="wsmodal__loading">cargando…</div>
              ) : isMarkdown ? (
                // FORMATTED markdown (react-markdown sanitizes — no raw HTML injection).
                <div className="wsmodal__md">
                  {/* remark-gfm adds tables / strikethrough / task-lists — the agents'
                      docs use tables heavily, which core markdown doesn't render. */}
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{view.content}</ReactMarkdown>
                </div>
              ) : (
                // Code / non-markdown: show raw, monospace.
                <pre className="wsmodal__pre">{view.content}</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
