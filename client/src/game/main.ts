import { AUTO, Game, Scale, type Types } from 'phaser';
import { BootScene } from './scenes/BootScene';
import { OfficeScene } from './scenes/OfficeScene';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  Game configuration + factory
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT `new Phaser.Game(config)` DOES UNDER THE HOOD
 * --------------------------------------------------
 * Constructing the Game kicks off the boot sequence, in order:
 *   1. Parse this config and create the RENDERER. With type AUTO it probes for a
 *      WebGL context and falls back to Canvas2D if unavailable. (Phaser 4 ships a
 *      brand-new WebGL renderer built on "render nodes" — the v3 "pipeline"
 *      system was removed. We don't touch pipelines, so the rewrite is invisible
 *      to us; this is exactly why the v3→v4 bump needed zero code changes here.)
 *   2. Create the singleton managers: TextureManager, Cache, SceneManager,
 *      InputManager, ScaleManager, SoundManager, AnimationManager.
 *   3. Insert the <canvas> into the `parent` element.
 *   4. Start the TimeStep: it schedules the first requestAnimationFrame, after
 *      which the game loop ticks ~60×/s on its own (update → physics → render).
 *
 * The GPU draws textured quads (a sprite = 2 triangles + a texture). Phaser
 * batches quads that share a texture into a single draw call, because the
 * CPU↔GPU round-trip — not raw pixel fill — is the real render bottleneck.
 */
const config: Types.Core.GameConfig = {
  // AUTO = prefer WebGL (GPU-batched), fall back to Canvas2D. Console banner
  // prints the chosen backend, e.g. "(WebGL | Web Audio)".
  type: AUTO,

  backgroundColor: '#1d2b3a',

  scale: {
    // RESIZE: the ScaleManager sizes the canvas to its parent and listens to the
    // window 'resize' event to reconfigure the WebGL viewport. In RESIZE mode the
    // width/height below are effectively driven by the parent; we keep '100%' to
    // make intent explicit.
    mode: Scale.RESIZE,
    autoCenter: Scale.CENTER_BOTH,
    width: '100%',
    height: '100%',
  },

  physics: {
    // Arcade: the simplest, fastest physics world (axis-aligned bounding boxes,
    // no rotation). Perfect for top-down office movement. We move BODIES (set
    // velocity) and let the world integrate position frame by frame.
    default: 'arcade',
    arcade: { debug: false },
  },

  // pixelArt → sets the GPU texture filter to NEAREST (not LINEAR), so scaled-up
  // pixel textures stay crisp instead of getting bilinear-blurred.
  pixelArt: true,

  // Scene order matters: the FIRST scene auto-starts; the rest stay dormant until
  // explicitly started. BootScene generates textures, then hands off to Office.
  scene: [BootScene, OfficeScene],
};

/**
 * Creates the single Phaser.Game instance, parented to the given DOM element id.
 * Called exactly once by PhaserGame.tsx (outside React's render cycle).
 */
export function StartGame(parent: string): Game {
  const game = new Game({ ...config, parent });

  // Dev-only debugging handle: inspect/drive the game from the console or from
  // automated e2e checks (e.g. read the live OfficeScene player position).
  // `import.meta.env.DEV` is replaced by a literal at build time, so this whole
  // block is tree-shaken out of production bundles.
  if (import.meta.env.DEV) {
    (window as unknown as { __SWARM__?: Game }).__SWARM__ = game;
  }

  return game;
}
