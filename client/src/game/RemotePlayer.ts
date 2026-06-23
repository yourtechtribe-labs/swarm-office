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
  /** Optional floating name label above the sprite (used to mark AI NPCs — F2). */
  private readonly label?: GameObjects.Text;
  // The last authoritative position the server reported. The sprite chases this.
  private targetX: number;
  private targetY: number;

  /**
   * @param label optional text shown above the avatar. We use it to mark an AI NPC
   *   visually (the spec calls for a label rather than a tint — `setTint` is a
   *   Phaser 4 breaking change, so a `Text` is both safe and clearer than an
   *   alpha/colour trick). Humans pass no label today; name labels for humans are a
   *   trivial future reuse of this same seam.
   * @param labelColor optional CSS hex for the label text (F4: each agent carries its
   *   own colour from the roster, so the multiple NPCs are distinguishable). Defaults
   *   to the F2 gold when an agent has no colour set.
   */
  constructor(scene: Scene, x: number, y: number, label?: string, labelColor?: string) {
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

    if (label) {
      // Centre the label horizontally over the sprite and sit it just above the
      // head. setOrigin(0.5,1) anchors the text by its bottom-centre so positioning
      // is "place the label's bottom at this point". Depth 11 keeps it above the
      // avatars (10) so it's never occluded by another sprite. We reposition it in
      // interpolate(), so the initial coords just avoid a one-frame flash at (0,0).
      this.label = scene.add
        .text(x, y - this.sprite.displayHeight / 2, label, {
          fontSize: '14px',
          color: labelColor || '#ffd866',
          backgroundColor: '#00000080',
          padding: { x: 4, y: 2 },
        })
        .setOrigin(0.5, 1)
        .setDepth(11);
    }
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
    // Keep the label glued above the (now-moved) sprite. Done here, after the lerp,
    // so the label tracks the smoothed position every frame rather than lagging it.
    if (this.label) {
      this.label.setPosition(this.sprite.x, this.sprite.y - this.sprite.displayHeight / 2);
    }
  }

  destroy(): void {
    this.sprite.destroy();
    // Destroy the label too, or it would linger as an orphan GameObject after the
    // avatar despawns (a leak that also paints stale text on screen).
    this.label?.destroy();
  }
}
