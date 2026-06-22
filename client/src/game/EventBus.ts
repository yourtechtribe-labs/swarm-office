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
export const EventBus = new Events.EventEmitter() as unknown as TypedEventBus;
