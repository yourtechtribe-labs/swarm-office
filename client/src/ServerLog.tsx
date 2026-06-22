import { useEffect, useRef, useState } from 'react';
import { EventBus } from './game/EventBus';
import './ServerLog.css';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ServerLog — an in-UI view of what the SERVER is doing
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The server broadcasts `server-log` events (NPC gateway vs scripted fallback,
 * join/leave) which OfficeScene relays onto the EventBus. This panel renders them so
 * you can see "what's happening" without tailing the terminal — e.g. confirm at a
 * glance whether M.IA is answering via the real LLM (🧠) or the scripted fallback
 * (⚠️/💬). Like chat, these are TRANSIENT: we keep only the last MAX lines (bounds
 * memory + DOM), and there's no history for late joiners.
 *
 * Collapsible so it stays out of the way; defaults open since the user asked to
 * watch events. The timestamp is stamped on ARRIVAL (client local time) — good
 * enough for a live debug view; the server doesn't send one.
 */
type LogLine = { id: number; level: 'info' | 'warn' | 'error'; text: string; time: string };
const MAX = 60;

export function ServerLog() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [open, setOpen] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);

  useEffect(() => {
    const onLog = (msg: { level: 'info' | 'warn' | 'error'; text: string }) =>
      setLines((prev) =>
        [
          ...prev,
          { ...msg, id: nextId.current++, time: new Date().toLocaleTimeString('es-ES', { hour12: false }) },
        ].slice(-MAX),
      );
    EventBus.on('server-log', onLog);
    return () => {
      EventBus.off('server-log', onLog);
    };
  }, []);

  // Keep the newest entry in view (only meaningful while expanded).
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className={open ? 'srvlog' : 'srvlog srvlog--collapsed'}>
      <button className="srvlog__head" onClick={() => setOpen((o) => !o)} aria-label="Toggle server log">
        <span>server log</span>
        <span className="srvlog__count">{lines.length}</span>
        <span className="srvlog__chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="srvlog__list" ref={listRef}>
          {lines.length === 0 ? (
            <div className="srvlog__empty">esperando eventos del servidor…</div>
          ) : (
            lines.map((l) => (
              <div key={l.id} className={`srvlog__line srvlog__line--${l.level}`}>
                <span className="srvlog__time">{l.time}</span>
                <span className="srvlog__text">{l.text}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
