# server/

Colyseus authoritative multiplayer server (Node + TypeScript).

**Responsibilities:**
- Define the office `Room` and its schema state (players, positions, zones, chat).
- Authoritative movement + state broadcast at a fixed tick (10–20 Hz).
- **Interest management (AOI)** as the office grows: only sync nearby players (F3).
- Persistence via Postgres + Drizzle (maps, users, layouts).

**To scaffold (F0):** `npm init colyseus-app@latest .` (TypeScript), define `OfficeRoom` +
`OfficeState` schema. Keep transport WebSocket; binary delta-sync is built into Colyseus schema.

_Not yet scaffolded — see [`../docs/SPEC.md`](../docs/SPEC.md)._
