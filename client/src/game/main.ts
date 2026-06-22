import { AUTO, Game, Scale, type Types } from 'phaser';
import { BootScene } from './scenes/BootScene';
import { OfficeScene } from './scenes/OfficeScene';

/**
 * Game config. RESIZE scale mode makes the canvas fill its parent and react to
 * window resizes — the office should use all available viewport space.
 * pixelArt:true disables texture smoothing so generated pixel textures stay crisp.
 */
const config: Types.Core.GameConfig = {
  type: AUTO, // WebGL when available, Canvas fallback
  backgroundColor: '#1d2b3a',
  scale: {
    mode: Scale.RESIZE,
    autoCenter: Scale.CENTER_BOTH,
    width: '100%',
    height: '100%',
  },
  physics: {
    default: 'arcade',
    arcade: { debug: false },
  },
  pixelArt: true,
  scene: [BootScene, OfficeScene],
};

export function StartGame(parent: string): Game {
  const game = new Game({ ...config, parent });
  // Dev-only handle for debugging / inspection from the console (and e2e checks).
  if (import.meta.env.DEV) {
    (window as unknown as { __SWARM__?: Game }).__SWARM__ = game;
  }
  return game;
}
