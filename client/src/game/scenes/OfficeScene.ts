import { Scene, Physics, Input, type Types } from 'phaser';
import { EventBus } from '../EventBus';

/** World size in pixels. The camera shows a window onto this larger world. */
const WORLD_W = 1600;
const WORLD_H = 1200;
/** Player speed in pixels per second (frame-rate independent — see update()). */
const SPEED = 220;

type DirKeys = Record<'up' | 'down' | 'left' | 'right', Input.Keyboard.Key>;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  OfficeScene — the playable office (F0 / Slice 1)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Scope: a tiled floor, the local player, WASD/arrow movement bounded to the
 * world, and a camera that follows. NO networking yet — that is Slice 2
 * (Colyseus presence), where a SERVER becomes the authority and this scene will
 * also render *remote* players interpolated between server snapshots.
 *
 * Per frame, Phaser runs this scene in two distinct phases:
 *   1. systems step  → Arcade World integrates bodies (position += velocity·dt).
 *   2. update()      → our code below reads input and SETS velocities.
 * The update/render split guarantees the whole frame's state is resolved before
 * anything is drawn (no logical tearing).
 */
export class OfficeScene extends Scene {
  /** The player SPRITE; its attached Arcade BODY is what we actually move. */
  private player!: Physics.Arcade.Sprite;
  /** Arrow keys (+ space/shift) — Key objects whose .isDown mirrors the DOM. */
  private cursors!: Types.Input.Keyboard.CursorKeys;
  /** WASD keys; kept as four explicit addKey() calls to preserve strong typing. */
  private wasd!: DirKeys;
  /** Last position we emitted, so we only notify React on actual change. */
  private lastEmit = { x: -1, y: -1 };

  constructor() {
    super('OfficeScene');
  }

  create() {
    // FLOOR: one big TileSprite (1600×1200) that REPEATS a 32×32 texture. It is a
    // single quad, not ~1875 sprites: the GPU sampler's REPEAT wrap mode tiles the
    // texture across UVs that run 0→50 (1600/32). One draw call for the whole
    // floor. setOrigin(0,0) anchors its top-left at world (0,0) (default is center).
    this.add.tileSprite(0, 0, WORLD_W, WORLD_H, 'floor').setOrigin(0, 0);

    // The physics world's bounds; bodies with collideWorldBounds clamp to these.
    this.physics.world.setBounds(0, 0, WORLD_W, WORLD_H);

    // PLAYER: physics.add.sprite creates the sprite AND attaches an Arcade Body.
    // The sprite follows the body: each frame the body integrates its position and
    // copies it to the sprite. We therefore steer the body (setVelocity), not the
    // sprite's x/y directly.
    this.player = this.physics.add.sprite(WORLD_W / 2, WORLD_H / 2, 'player');
    this.player.setScale(2);
    this.player.setCollideWorldBounds(true);

    // CAMERA: a window onto the world. setBounds stops it from showing empty space
    // past the world edges. startFollow(target, roundPixels, lerpX, lerpY) eases
    // the camera toward the player: scroll += (target − scroll) · 0.1 each frame —
    // a smooth, slightly elastic follow instead of a rigid lock. roundPixels=true
    // keeps pixel-art crisp by avoiding sub-pixel camera offsets.
    this.cameras.main.setBounds(0, 0, WORLD_W, WORLD_H);
    this.cameras.main.startFollow(this.player, true, 0.1, 0.1);

    // INPUT: during boot the KeyboardManager attached keydown/keyup listeners on
    // window. Each Key object below has an .isDown flag the manager flips on
    // keydown/keyup — i.e. .isDown is a live mirror of the physical key state.
    const kb = this.input.keyboard!;
    this.cursors = kb.createCursorKeys(); // arrows + space + shift
    this.wasd = {
      up: kb.addKey('W'),
      down: kb.addKey('S'),
      left: kb.addKey('A'),
      right: kb.addKey('D'),
    };

    // Tell any React listeners the scene is live and safe to drive/inspect.
    EventBus.emit('current-scene-ready', this);
  }

  update() {
    // 1) READ INPUT — combine arrows and WASD with OR.
    const left = this.cursors.left.isDown || this.wasd.left.isDown;
    const right = this.cursors.right.isDown || this.wasd.right.isDown;
    const up = this.cursors.up.isDown || this.wasd.up.isDown;
    const down = this.cursors.down.isDown || this.wasd.down.isDown;

    // 2) SET VELOCITY (not position): we set velocity and let the physics world
    // integrate position as pos += velocity · (delta/1000). That makes movement
    // frame-rate INDEPENDENT — same real speed at 30 fps or 144 fps — and keeps
    // collisions correct (moving x/y by hand teleports through walls on slow
    // frames).
    this.player.setVelocity(0);
    if (left) this.player.setVelocityX(-SPEED);
    else if (right) this.player.setVelocityX(SPEED);
    if (up) this.player.setVelocityY(-SPEED);
    else if (down) this.player.setVelocityY(SPEED);

    // 3) NORMALIZE DIAGONALS: pressing right+down gives velocity (220,220) whose
    // magnitude is 220·√2 ≈ 311 → ~41% faster diagonally. setLength rescales the
    // vector back to exactly SPEED while preserving direction.
    const body = this.player.body as Physics.Arcade.Body;
    if (body.velocity.x !== 0 || body.velocity.y !== 0) {
      body.velocity.setLength(SPEED);
    }

    // 4) THROTTLED BRIDGE: emit to React only when the rounded position actually
    // changed. Without this we'd fire 60×/s even while standing still, forcing
    // wasteful setState churn across the React/Phaser boundary.
    const x = Math.round(this.player.x);
    const y = Math.round(this.player.y);
    if (x !== this.lastEmit.x || y !== this.lastEmit.y) {
      this.lastEmit = { x, y };
      EventBus.emit('player-moved', { x, y });
    }
  }
}
