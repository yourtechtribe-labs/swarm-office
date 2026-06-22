import { Scene } from 'phaser';

/**
 * Boot scene: generates placeholder textures at runtime so the repo needs no
 * binary art assets yet (SPEC §7 leaves the pixel-art tileset/sprite choice open).
 * Once textures exist it hands off to the OfficeScene.
 */
export class BootScene extends Scene {
  constructor() {
    super('BootScene');
  }

  create() {
    const g = this.add.graphics();

    // --- player sprite (16x16): tiny head + body, scaled up in-scene ---
    g.fillStyle(0x4fd1c5, 1); // teal body
    g.fillRect(2, 5, 12, 11);
    g.fillStyle(0xffe0bd, 1); // skin head
    g.fillRect(4, 0, 8, 6);
    g.generateTexture('player', 16, 16);
    g.clear();

    // --- floor tile (32x32): dark panel with a subtle grid line ---
    g.fillStyle(0x24323f, 1);
    g.fillRect(0, 0, 32, 32);
    g.lineStyle(1, 0x32424f, 1);
    g.strokeRect(0, 0, 32, 32);
    g.generateTexture('floor', 32, 32);

    g.destroy();

    this.scene.start('OfficeScene');
  }
}
