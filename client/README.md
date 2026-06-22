# client/

Phaser 3 (WebGL) game client wrapped in a Vite + React shell.

**Responsibilities:**
- Render the pixel office (tilemap from Tiled), the local player and remote players as sprites.
- Capture input (movement) and send it to the Colyseus server.
- Apply server state with **client-side interpolation** (smooth 60fps from a lower server tick).
- UI shell (React): login/name entry, chat panel, zone indicators.

**To scaffold (F0):** `npm create vite@latest . -- --template react-ts`, add `phaser` and
`colyseus.js`. Keep the Phaser game instance outside React render; bridge via a thin store.

_Not yet scaffolded — see [`../docs/SPEC.md`](../docs/SPEC.md)._
