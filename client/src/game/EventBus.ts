import { Events } from 'phaser';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  EventBus — the React ↔ Phaser bridge (publish/subscribe)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS
 * ---------------
 * Two independent "clocks" run in the same browser tab:
 *   - React's render cycle  → event-driven (state change ⇒ re-render).
 *   - Phaser's game loop     → clock-driven (~60 fps via requestAnimationFrame).
 *
 * If Phaser lived *inside* a React component, every setState (e.g. 60×/s HUD
 * updates) would risk tearing down and recreating the game engine. So Phaser is
 * created OUTSIDE the React tree (see PhaserGame.tsx) and the two sides talk only
 * through this bus. Neither side imports the other; both only know the bus and a
 * set of event *names*. That decoupling lets us add/remove listeners on either
 * side without touching the other.
 *
 * WHAT AN EventEmitter IS, UNDER THE HOOD
 * ---------------------------------------
 * Phaser ships EventEmitter3 (re-exported as Phaser.Events.EventEmitter). It is
 * the classic pub/sub data structure: internally a map of
 *   { eventName: [listener, listener, ...] }.
 *   - emit(name, ...args)  → synchronously calls every listener registered for
 *     `name`, in registration order, passing `args`.
 *   - on(name, fn)         → appends a listener.
 *   - off(name, fn)        → removes it (REQUIRED in React effect cleanup, or
 *     each StrictMode double-mount leaks one more listener).
 *
 * TYPE SAFETY (the improvement over a raw emitter)
 * ------------------------------------------------
 * Phaser's EventEmitter is untyped: emit(string, any). That lets a typo'd event
 * name or a wrong payload shape slip through to runtime. We layer a typed facade
 * (`SwarmEvents` + `TypedEventBus`) so the compiler checks event names AND payload
 * types at every emit/on/off. Listeners get their payload typed automatically.
 *
 * To add a new event: declare it once in `SwarmEvents` below; every call site is
 * then type-checked against that declaration.
 */

/** The single source of truth for every cross-boundary event and its payload. */
export interface SwarmEvents {
  /** Fired by a scene in create() once it is fully set up and safe to drive. */
  'current-scene-ready': (scene: Phaser.Scene) => void;
  /** Fired when the local player's rounded position changes (throttled). */
  'player-moved': (pos: { x: number; y: number }) => void;
  /** Fired when someone joins/leaves the room — total avatars present (incl. you). */
  'presence-changed': (count: number) => void;
  /** Fired when the local player enters/leaves a zone — the zone's display name ('' = none). */
  'zone-changed': (zoneName: string) => void;
  /** React → scene: the user submitted a chat line; the scene relays it to the room. */
  'chat-send': (text: string) => void;
  /**
   * React → scene: the user typed a slash-command to drive the AI agents (F4a). It's a
   * SEPARATE channel from chat so it never renders as a chat line: `/seed <topic>`
   * starts/re-seeds a round, `/stop` halts it. The scene relays it to the server's
   * `agent-cmd` message, where the ConversationManager (and server-side validation) live.
   */
  'agent-command': (cmd: { kind: 'seed'; topic: string } | { kind: 'stop' }) => void;
  /**
   * scene → React: a chat line arrived (self = our own message, echoed back).
   * `name` is the author's display name resolved from synced state when available
   * (e.g. the NPC "M.IA"); '' when the sender has no name yet (humans today), so the
   * panel falls back to a short id. The raw `from` (sessionId or NPC key) stays for
   * self-detection and as that fallback.
   */
  'chat-message': (msg: { from: string; name: string; text: string; self: boolean }) => void;
  /** React → scene: the chat input gained/lost focus → scene toggles game keyboard. */
  'chat-focus': (focused: boolean) => void;
  /** React → scene: user clicked "Join voice" (the gesture that unlocks mic + audio). */
  'voice-join': () => void;
  /** scene → React: voice status (joined, or an error such as denied mic). */
  'voice-state': (state: { joined: boolean; error?: string }) => void;
  /** scene → React: a server-side event (NPC gateway/fallback, join/leave) for the
   *  in-UI log panel. Transient, like chat — surfaces what the server is doing. */
  'server-log': (msg: { level: 'info' | 'warn' | 'error'; text: string }) => void;
  /** F6 — workspace explorer. React → scene: ask for the file list, or one file's content.
   *  The scene relays it to the room (ws-list / ws-read); the office proxies to the harness. */
  'ws-request': (req: { action: 'list' } | { action: 'read'; path: string }) => void;
  /** scene → React: the current zone's workspace listing, or an error (harness down, etc.). */
  'ws-files': (msg: { files: string[] } | { error: string }) => void;
  /** scene → React: one file's content (clipped when `truncated`), or an error. */
  'ws-file': (msg: { path: string; content: string; truncated: boolean } | { error: string }) => void;
  /** scene → React: a work turn changed files in a zone → the panel should re-list. */
  'ws-changed': (msg: { zone: string }) => void;
}

/** A typed view over Phaser's EventEmitter, constrained to `SwarmEvents`. */
export interface TypedEventBus {
  emit<K extends keyof SwarmEvents>(
    event: K,
    ...args: Parameters<SwarmEvents[K]>
  ): boolean;
  on<K extends keyof SwarmEvents>(event: K, fn: SwarmEvents[K], context?: unknown): this;
  once<K extends keyof SwarmEvents>(event: K, fn: SwarmEvents[K], context?: unknown): this;
  off<K extends keyof SwarmEvents>(
    event: K,
    fn?: SwarmEvents[K],
    context?: unknown,
    once?: boolean,
  ): this;
}

// One shared emitter instance for the whole app, cast to the typed facade. The
// runtime object is a plain Phaser EventEmitter; the cast only adds compile-time
// guarantees (zero runtime cost).
//
// HMR FOOTGUN (why we stash the instance in import.meta.hot.data)
// --------------------------------------------------------------
// This module exports a SINGLETON. The bus bridges two worlds with very different
// lifetimes under Vite HMR:
//   • React components (Chat, ServerLog) hot-RELOAD — Fast Refresh re-imports this
//     module and re-runs their effects.
//   • The Phaser scene is created ONCE and is NOT re-created on HMR; it keeps the
//     EventBus reference it captured at create() and its listeners live on THAT
//     instance.
// If editing this file made a FRESH emitter, React would emit on the new instance
// while the running scene still listens on the old one — the bridge silently SPLITS,
// and every React→scene event (e.g. 'chat-focus', which suspends the game keyboard so
// you can type WASD into chat) stops arriving. Reusing the instance stashed in
// `import.meta.hot.data` keeps BOTH halves on one emitter across hot reloads. In a
// production build `import.meta.hot` is undefined and this is just `new EventEmitter()`.
const hot = import.meta.hot;
const preserved = (hot?.data as { bus?: TypedEventBus } | undefined)?.bus;
export const EventBus: TypedEventBus =
  preserved ?? (new Events.EventEmitter() as unknown as TypedEventBus);
if (hot) hot.data.bus = EventBus;
