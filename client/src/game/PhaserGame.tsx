import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { Game } from 'phaser';
import { StartGame } from './main';

export interface PhaserGameRef {
  game: Game | null;
}

/**
 * Owns the Phaser.Game instance and keeps it OUTSIDE React's render cycle.
 *
 * The game is created once in useLayoutEffect (before paint, so the canvas
 * mounts without a flash) and destroyed on unmount. Under React StrictMode the
 * effect runs mount → cleanup → mount in dev; the create-once guard + destroy
 * cleanup means we still end with exactly one live game. We never re-create on
 * re-render — React only mounts the host <div>, Phaser does the rest.
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
  }, []);

  useImperativeHandle(ref, () => ({ game: gameRef.current }), []);

  return <div id="game-container" />;
});
