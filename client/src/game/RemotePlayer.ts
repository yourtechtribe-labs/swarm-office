import type { GameObjects, Scene } from 'phaser';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  RemotePlayer — the "remote" half of the player seam
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE SEAM (why this class exists)
 * --------------------------------
 * There are two kinds of avatar in the office, and they are driven completely
 * differently:
 *   • the LOCAL player — input-driven, simulated by Arcade physics, rendered
 *     instantly (it stays in OfficeScene as `this.player`). YOU own its position.
 *   • a REMOTE player — driven by the SERVER. We never simulate it; we only know
 *     its last reported position and ease the sprite toward it.
 * Keeping the remote as its own small class (rather than bolting remote-handling
 * onto the local-player code path) is the "player seam": remotes are not a
 * parallel code path, they're the second kind of avatar with their own update
 * rule (interpolate), wired by OfficeScene's network callbacks.
 *
 * WHY INTERPOLATE (the third-clock problem)
 * -----------------------------------------
 * The server broadcasts positions at its patch rate (~20 Hz) but we render at
 * ~60 Hz. If we snapped the sprite to each received position it would jump every
 * 3rd frame. Easing a fraction of the remaining distance each frame turns those
 * discrete updates into smooth motion — the same lerp idea as the Slice 1 camera,
 * now applied across the network.
 */
export class RemotePlayer {
  readonly sprite: GameObjects.Sprite;
  // The last authoritative position the server reported. The sprite chases this.
  private targetX: number;
  private targetY: number;

  constructor(scene: Scene, x: number, y: number) {
    this.sprite = scene.add.sprite(x, y, 'player').setScale(2);
    // Slight transparency so a remote avatar reads as distinct from your own.
    // (We avoid setTint on purpose — the tint API is one of Phaser 4's breaking
    // changes; alpha is unchanged and enough here.)
    this.sprite.setAlpha(0.8);
    // Depth 10 = the avatar layer, above the zone overlays (depth 1). Zones are
    // added asynchronously (after this sprite), so without explicit depth they'd
    // paint over remote avatars.
    this.sprite.setDepth(10);
    this.targetX = x;
    this.targetY = y;
  }

  /** The server told us this remote's new authoritative position. */
  setTarget(x: number, y: number): void {
    this.targetX = x;
    this.targetY = y;
  }

  /**
   * Called every client frame: ease the sprite toward the last server position.
   * Simple "lerp-to-latest". A render-delay interpolation buffer (keep a short
   * history and render ~100 ms in the past for perfectly smooth motion under
   * jitter) is the known next refinement — deliberately not built yet.
   */
  interpolate(): void {
    const LERP = 0.2;
    this.sprite.x += (this.targetX - this.sprite.x) * LERP;
    this.sprite.y += (this.targetY - this.sprite.y) * LERP;
  }

  destroy(): void {
    this.sprite.destroy();
  }
}
