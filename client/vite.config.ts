import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Split Phaser into its OWN chunk, separate from our app code.
        // Why: Phaser is ~1.5 MB and almost never changes between deploys, while
        // our app code changes constantly. Separate chunks get separate content
        // hashes, so the browser keeps the cached Phaser chunk across app updates
        // (it only re-downloads the small app chunk). It does not reduce total
        // size — it improves cacheability and makes the bundle composition
        // explicit. (True size cuts would need Phaser 4's modular subpath imports
        // or lazy-loading the game behind a dynamic import().)
        manualChunks: (id) => {
          if (id.includes('node_modules/phaser')) return 'phaser';
        },
      },
    },
  },
});
