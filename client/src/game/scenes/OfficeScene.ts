import { Scene, Physics, Input, type Types } from 'phaser';
import { EventBus } from '../EventBus';

const WORLD_W = 1600;
const WORLD_H = 1200;
const SPEED = 220;

type DirKeys = Record<'up' | 'down' | 'left' | 'right', Input.Keyboard.Key>;

/**
 * The local office. F0/Slice 1 scope: a tiled floor, the local player, WASD/arrow
 * movement with world bounds, and a camera that follows. No networking yet — that
 * is Slice 2 (Colyseus presence). The scene emits 'player-moved' (throttled to
 * actual position changes) so the React HUD can show coordinates.
 */
export class OfficeScene extends Scene {
  private player!: Physics.Arcade.Sprite;
  private cursors!: Types.Input.Keyboard.CursorKeys;
  private wasd!: DirKeys;
  private lastEmit = { x: -1, y: -1 };

  constructor() {
    super('OfficeScene');
  }

  create() {
    // Repeating floor covering the whole world.
    this.add.tileSprite(0, 0, WORLD_W, WORLD_H, 'floor').setOrigin(0, 0);

    this.physics.world.setBounds(0, 0, WORLD_W, WORLD_H);

    this.player = this.physics.add.sprite(WORLD_W / 2, WORLD_H / 2, 'player');
    this.player.setScale(2);
    this.player.setCollideWorldBounds(true);

    this.cameras.main.setBounds(0, 0, WORLD_W, WORLD_H);
    this.cameras.main.startFollow(this.player, true, 0.1, 0.1);

    const kb = this.input.keyboard!;
    this.cursors = kb.createCursorKeys();
    this.wasd = {
      up: kb.addKey('W'),
      down: kb.addKey('S'),
      left: kb.addKey('A'),
      right: kb.addKey('D'),
    };

    EventBus.emit('current-scene-ready', this);
  }

  update() {
    const left = this.cursors.left.isDown || this.wasd.left.isDown;
    const right = this.cursors.right.isDown || this.wasd.right.isDown;
    const up = this.cursors.up.isDown || this.wasd.up.isDown;
    const down = this.cursors.down.isDown || this.wasd.down.isDown;

    this.player.setVelocity(0);
    if (left) this.player.setVelocityX(-SPEED);
    else if (right) this.player.setVelocityX(SPEED);
    if (up) this.player.setVelocityY(-SPEED);
    else if (down) this.player.setVelocityY(SPEED);

    // Normalize so diagonal movement isn't ~1.41x faster than orthogonal.
    const body = this.player.body as Physics.Arcade.Body;
    if (body.velocity.x !== 0 || body.velocity.y !== 0) {
      body.velocity.setLength(SPEED);
    }

    const x = Math.round(this.player.x);
    const y = Math.round(this.player.y);
    if (x !== this.lastEmit.x || y !== this.lastEmit.y) {
      this.lastEmit = { x, y };
      EventBus.emit('player-moved', { x, y });
    }
  }
}
