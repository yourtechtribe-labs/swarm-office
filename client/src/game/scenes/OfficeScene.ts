import { Scene, Physics, Input, type Types } from 'phaser';
import { EventBus } from '../EventBus';
import { connectToOffice, getStateCallbacks, type OfficeRoom, type PlayerView } from '../../net/room';
import { RemotePlayer } from '../RemotePlayer';

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
  /** The Colyseus room, once joined (async; undefined until connected). */
  private room?: OfficeRoom;
  /** Remote avatars, keyed by their server sessionId. */
  private readonly remotes = new Map<string, RemotePlayer>();

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

    // NETWORKING: join the shared office. Connection is async and create() is not,
    // so we connect in the background and wire callbacks once joined. If the server
    // is down the catch logs it and local play still works (graceful degradation).
    connectToOffice()
      .then((room) => this.onConnected(room))
      .catch((err) => console.error('[net] could not join office:', err));
  }

  /**
   * Wire the room's state callbacks once we've joined. This is where the "player
   * seam" pays off: the server's players map drives spawn/despawn of RemotePlayer
   * instances, while our own avatar stays the local Arcade sprite.
   */
  private onConnected(room: OfficeRoom) {
    this.room = room;
    // `$` is the schema-callbacks proxy: `$(stateObject)` returns an object whose
    // collection fields expose onAdd/onRemove and whose schema fields expose
    // listen/onChange. This is the Colyseus 0.17 / Schema v4 callbacks API.
    const $ = getStateCallbacks(room);

    const emitPresence = () => EventBus.emit('presence-changed', room.state.players.size);

    // A player was added to the room state.
    $(room.state).players.onAdd((player: PlayerView, sessionId: string) => {
      emitPresence();
      // Our own avatar is already the local Arcade sprite — skip it so we don't
      // render ourselves twice (the relay model: we never render the server's copy
      // of our own position; we own it locally for zero input lag).
      if (sessionId === room.sessionId) return;
      const remote = new RemotePlayer(this, player.x, player.y);
      this.remotes.set(sessionId, remote);
      // Each time the server updates this remote, repoint its interpolation target.
      $(player).onChange(() => remote.setTarget(player.x, player.y));
    });

    // A player left: despawn its avatar.
    $(room.state).players.onRemove((_player: PlayerView, sessionId: string) => {
      this.remotes.get(sessionId)?.destroy();
      this.remotes.delete(sessionId);
      emitPresence();
    });
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
    // vector back to exactly SPEED while preserving direction. Guard on BOTH axes
    // (&&), not either (||): single-axis velocity is already exactly SPEED, so
    // rescaling it would be a redundant sqrt+rescale every frame in the common
    // straight-line case. Only true diagonals have the wrong magnitude.
    const body = this.player.body as Physics.Arcade.Body;
    if (body.velocity.x !== 0 && body.velocity.y !== 0) {
      body.velocity.setLength(SPEED);
    }

    // 4) THROTTLED BRIDGE: emit to React only when the rounded position actually
    // changed. Without this we'd fire 60×/s even while standing still, forcing
    // wasteful setState churn across the React/Phaser boundary.
    const x = Math.round(this.player.x);
    const y = Math.round(this.player.y);
    if (x !== this.lastEmit.x || y !== this.lastEmit.y) {
      // Mutate lastEmit IN PLACE — it never leaves this scene, so reusing the
      // object avoids ~60 short-lived allocations/sec (GC pressure) while moving.
      // The emit payload below, by contrast, MUST be a fresh object: it escapes
      // into React state via setPos, where reusing a reference would defeat
      // React's change detection.
      this.lastEmit.x = x;
      this.lastEmit.y = y;
      EventBus.emit('player-moved', { x, y });
      // Push our authoritative-for-ourselves position to the server (relay model).
      // Reusing the same change-throttle means we only send on movement — no
      // 60×/s spam of identical positions. `?.` because the join is async.
      this.room?.send('move', { x, y });
    }

    // 5) INTERPOLATE REMOTES every frame: ease each remote avatar toward its last
    // server-reported position. Runs unconditionally (not throttled) because the
    // smoothing must happen on frames where no new server update arrived — that's
    // the whole point of bridging the ~20Hz server tick to ~60Hz rendering.
    for (const remote of this.remotes.values()) {
      remote.interpolate();
    }
  }
}
