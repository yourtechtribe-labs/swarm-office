import { Scene } from 'phaser';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  BootScene — generates placeholder art at runtime, then hands off
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SCENE LIFECYCLE (the methods Phaser calls for you)
 * --------------------------------------------------
 *   init(data)  → before loading; receives data from whoever started the scene.
 *   preload()   → async asset loading; Phaser waits for it to finish.
 *   create()    → called ONCE when everything is ready; build the scene here.
 *   update(t,dt)→ called EVERY frame while the scene is active.
 * We skip preload() because we load no files — we synthesize textures in create().
 *
 * WHAT generateTexture() DOES UNDER THE HOOD
 * ------------------------------------------
 * A "texture" in a 2D engine is not a PNG — it's a block of pixels in GPU memory
 * (VRAM) registered under a string key. generateTexture():
 *   1. Creates a RenderTexture of the given size — a framebuffer in the GPU you
 *      can draw INTO (not just the screen).
 *   2. Renders the Graphics' vector commands (fillRect, etc.) into it.
 *   3. Registers the result in the TextureManager under the key.
 * Afterwards, `this.add.sprite(x, y, 'player')` makes a quad that samples that
 * VRAM texture. No files, no HTTP requests — the art was born on the GPU. This is
 * how the repo ships with zero binary art assets (SPEC §7 leaves the real
 * pixel-art tileset/sprite choice open for later).
 */
export class BootScene extends Scene {
  constructor() {
    // The string key identifies this scene to the SceneManager (start/stop/get).
    super('BootScene');
  }

  create() {
    // Graphics is an immediate-mode vector drawing object: it records draw
    // commands we then "bake" into a texture.
    const g = this.add.graphics();

    // --- player sprite (16×16): tiny head + body, scaled up in-scene ---
    g.fillStyle(0x4fd1c5, 1); // teal body
    g.fillRect(2, 5, 12, 11);
    g.fillStyle(0xffe0bd, 1); // skin head
    g.fillRect(4, 0, 8, 6);
    g.generateTexture('player', 16, 16);
    g.clear(); // reuse the same Graphics object for the next texture

    // --- floor tile (32×32): dark panel with a subtle grid line ---
    g.fillStyle(0x24323f, 1);
    g.fillRect(0, 0, 32, 32);
    g.lineStyle(1, 0x32424f, 1);
    g.strokeRect(0, 0, 32, 32);
    g.generateTexture('floor', 32, 32);

    g.destroy(); // textures are baked into VRAM; the Graphics object is now waste

    // Stop this scene and start the real one. BootScene's sole job is done.
    this.scene.start('OfficeScene');
  }
}
