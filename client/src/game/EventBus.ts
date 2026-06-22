import { Events } from 'phaser';

/**
 * Singleton event emitter that bridges React <-> Phaser.
 *
 * Why a separate bus instead of props: the Phaser game instance lives OUTSIDE
 * React's render cycle (see PhaserGame.tsx). Passing data through React props
 * would couple the game loop to re-renders. The bus lets either side emit/listen
 * without either owning the other's lifecycle.
 *
 * Convention: scenes emit ('current-scene-ready', scene) when ready, and
 * gameplay events ('player-moved', ...) as they happen. React listens in effects.
 */
export const EventBus = new Events.EventEmitter();
