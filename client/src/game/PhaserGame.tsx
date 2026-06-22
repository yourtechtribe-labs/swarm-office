import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { Game } from 'phaser';
import { StartGame } from './main';

export interface PhaserGameRef {
  game: Game | null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PhaserGame — the React side of the bridge
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * React's only job here is to mount an empty <div> ("the room") and let Phaser
 * furnish it with a <canvas> ("the tenant"). After that, React never touches the
 * canvas again. This is THE pattern for embedding any imperative library
 * (Phaser, Mapbox, Monaco, a D3 chart) inside React.
 *
 * KEY MECHANICS
 * -------------
 * • useRef — a mutable box that persists across renders and does NOT trigger a
 *   re-render when mutated. We store the Phaser.Game here. (Using useState would
 *   re-render React on every mutation — the opposite of what we want: the game
 *   must live outside the render cycle.)
 *
 * • useLayoutEffect vs useEffect — both run after mount, but useLayoutEffect runs
 *   synchronously AFTER the DOM is mutated and BEFORE the browser paints. So the
 *   #game-container <div> already exists and Phaser injects its <canvas> before
 *   the first paint → no flash of an empty frame. (useEffect runs after paint.)
 *
 * • create-once guard + destroy cleanup — together they make this idempotent
 *   under React StrictMode, which in DEV intentionally runs effects twice
 *   (mount → cleanup → mount) to surface non-idempotent effects. Sequence:
 *   create → destroy(true) → create ⇒ we end with exactly ONE live game. (That's
 *   why the Phaser banner logs "[2 times]" in the dev console — harmless.)
 *   destroy(true) also frees the WebGL context and removes the canvas from DOM.
 *
 * • forwardRef + useImperativeHandle — expose { game } to the parent for any
 *   future imperative access. Not load-bearing yet; it's the official-template
 *   shape, ready to grow.
 */
export const PhaserGame = forwardRef<PhaserGameRef>(function PhaserGame(_props, ref) {
  const gameRef = useRef<Game | null>(null);

  useLayoutEffect(() => {
    if (gameRef.current === null) {
      gameRef.current = StartGame('game-container');
    }
    return () => {
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
    // Empty deps: run once on mount (plus the StrictMode double-invoke in dev).
    // The game must never be recreated on a React re-render.
  }, []);

  useImperativeHandle(ref, () => ({ game: gameRef.current }), []);

  // The empty host element Phaser fills with its <canvas>.
  return <div id="game-container" />;
});
