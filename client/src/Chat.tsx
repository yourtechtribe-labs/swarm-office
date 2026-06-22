import { useEffect, useRef, useState } from 'react';
import { EventBus } from './game/EventBus';
import './Chat.css';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  Chat — the React chat panel (the React→scene direction of the bus)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is where the EventBus finally goes BOTH ways. Until now React only
 * listened (Phaser → React). Chat adds the reverse: the user types here, React
 * emits 'chat-send' / 'chat-focus' on the bus, and OfficeScene relays to the
 * Colyseus room. React still never touches the network directly — the scene owns
 * the room; the bus is the contract between them.
 *
 * Messages are TRANSIENT (the server broadcasts, it doesn't store them), so the
 * panel only shows lines received while connected. We keep the last MAX_LINES so
 * an append-only log can't grow unbounded over a long session.
 *
 * SECURITY: the message text is rendered as JSX text content, which React escapes
 * automatically — so a message like `<img onerror=...>` shows as literal
 * characters, not executed (no XSS). The server is the real validation boundary
 * (trim + length cap); this is defence in depth.
 */
type ChatLine = { id: number; from: string; name: string; text: string; self: boolean };
const MAX_LINES = 50;

export function Chat() {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);

  // Receive: scene → bus → here. slice(-MAX_LINES) bounds memory + DOM nodes.
  useEffect(() => {
    const onMessage = (msg: { from: string; name: string; text: string; self: boolean }) =>
      setLines((prev) => [...prev, { ...msg, id: nextId.current++ }].slice(-MAX_LINES));
    EventBus.on('chat-message', onMessage);
    return () => {
      EventBus.off('chat-message', onMessage);
    };
  }, []);

  // Keep the newest line in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const send = (e: React.FormEvent) => {
    // A real <form onSubmit> + preventDefault: Enter submits here once, and the
    // keypress doesn't bubble into a second handler. (Phaser's keyboard is also
    // disabled while this input is focused — see onChatFocus in OfficeScene.)
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    EventBus.emit('chat-send', text); // scene → room.send('chat'); server validates again
    setDraft(''); // clear but keep focus, so the user can keep typing
  };

  return (
    <div className="chat">
      <div className="chat__list" ref={listRef}>
        {lines.map((l) => (
          <div key={l.id} className="chat__line">
            <span className={l.self ? 'chat__who chat__who--self' : 'chat__who'}>
              {/* Prefer a real display name (e.g. the NPC "M.IA"); fall back to a
                  short id when the sender is unnamed (humans, for now). */}
              {l.self ? 'you' : l.name || l.from.slice(0, 4)}
            </span>
            <span className="chat__text">{l.text}</span>
          </div>
        ))}
      </div>
      <form className="chat__form" onSubmit={send}>
        <input
          className="chat__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          // Focus/blur drive the game keyboard toggle via the bus so WASD typed
          // into this box doesn't move the avatar.
          onFocus={() => EventBus.emit('chat-focus', true)}
          onBlur={() => EventBus.emit('chat-focus', false)}
          placeholder="Type a message…"
          maxLength={500}
          aria-label="Chat message"
        />
      </form>
    </div>
  );
}
