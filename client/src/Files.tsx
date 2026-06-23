import { useEffect, useRef, useState } from 'react';
import { EventBus } from './game/EventBus';
import './Files.css';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  Files — the workspace EXPLORER (F6): the office's "codebase", live
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The AI agents build real files in their per-zone workspace (F5 `do_work`). This panel
 * makes that visible: a read-only tree of the current zone's files + a viewer for one
 * selected file, refreshing live as the agents work.
 *
 * DATA FLOW (same seam as ServerLog — never touches the room directly)
 * -------------------------------------------------------------------
 * We talk only to the EventBus. `ws-request` goes React → scene → room → harness; the
 * replies (`ws-files`, `ws-file`) and the change push (`ws-changed`) come back the other
 * way. The office proxies to the harness, so the browser never sees it.
 *
 * LIVE REFRESH is a PUSH, not a poll: after a work turn changes files the server broadcasts
 * `ws-changed`, and we re-list — but ONLY while the panel is open (no fetching what nobody
 * sees). Read-only by design: the panel looks, it never writes.
 */
type Viewed = { content: string; truncated: boolean };

export function Files() {
  const [open, setOpen] = useState(true);
  const [files, setFiles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<Viewed | null>(null);
  // openRef mirrors `open` so the (stable) ws-changed listener can read the LATEST value
  // without re-subscribing on every toggle.
  const openRef = useRef(open);
  openRef.current = open;

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
      if ('error' in msg) {
        setError(msg.error);
        setView(null);
      } else {
        setError(null);
        setSelected(msg.path);
        setView({ content: msg.content, truncated: msg.truncated });
      }
    };
    // A work turn changed files → re-list, but only if we're visible.
    const onChanged = () => {
      if (openRef.current) requestList();
    };
    EventBus.on('ws-files', onFiles);
    EventBus.on('ws-file', onFile);
    EventBus.on('ws-changed', onChanged);
    requestList(); // initial listing on mount
    // Cleanup REQUIRED (StrictMode double-mount would otherwise stack listeners).
    return () => {
      EventBus.off('ws-files', onFiles);
      EventBus.off('ws-file', onFile);
      EventBus.off('ws-changed', onChanged);
    };
  }, []);

  const toggle = () =>
    setOpen((o) => {
      const next = !o;
      if (next) requestList(); // refresh on (re)open — it may have changed while hidden
      return next;
    });

  const openFile = (path: string) => {
    setSelected(path);
    EventBus.emit('ws-request', { action: 'read', path });
  };

  return (
    <div className={open ? 'files' : 'files files--collapsed'}>
      <button className="files__head" onClick={toggle} aria-label="Toggle workspace files">
        <span>workspace</span>
        <span className="files__count">{files.length}</span>
        <span className="files__chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="files__body">
          <div className="files__tree">
            {error && <div className="files__error">⚠️ {error}</div>}
            {!error && files.length === 0 && <div className="files__empty">workspace vacío — los agentes aún no han creado nada</div>}
            {files.map((f) => (
              <button
                key={f}
                className={f === selected ? 'files__item files__item--sel' : 'files__item'}
                onClick={() => openFile(f)}
                title={f}
              >
                {f}
              </button>
            ))}
          </div>
          {view && (
            <div className="files__viewer">
              <div className="files__viewer-head">
                {selected}
                {view.truncated && <span className="files__trunc"> · truncado</span>}
              </div>
              <pre className="files__content">{view.content}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
