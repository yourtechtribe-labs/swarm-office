# swarm-office — Spec & Charter

> Source of truth del proyecto. Decisiones tomadas el 2026-06-22 (Albert Gil López, YourTechTribe).

## 1. Visión

Oficina virtual pixel-art **open-source**, multijugador y self-hostable, donde el equipo de
YourTechTribe entra, se mueve, charla y trabaja — y donde los **agentes M.IA / Predicta aparecen
como NPCs** (ciudadanos de primera de la oficina). Recrea el "remote office" que el equipo tuvo con
Gather, pero **poseído, con licencia limpia (MIT) y agent-native**.

Diferencial vs alternativas:
- **WorkAdventure**: da la oficina + voz, pero los agentes IA no son de primera clase.
- **DeskRPG**: tiene NPCs IA, pero es text-only y su licencia es `NOASSERTION` (no usable).
- **swarm-office**: combina ambos — presencia de equipo **+ agentes IA**, desde cero, MIT.

## 2. Decisiones (2026-06-22)

| Decisión | Valor |
|----------|-------|
| Nombre | **swarm-office** (verificado libre: GitHub org + npm) |
| Licencia | **MIT** |
| Alcance MVP (F0) | **Texto primero**: walk + presence + zonas + chat de texto. Voz en F1 |
| Repo | **`yourtechtribe-labs/swarm-office`**, público desde el día 1 |
| Código | `~/dev/swarm-office/` (local, fuera de Drive). Docs/spec viven en el repo |

## 3. Restricción legal (dura)

**DeskRPG es solo REFERENCIA de UX y del patrón de NPCs. NO se copia código de DeskRPG.**
Su licencia es `NOASSERTION` (sin grant open-source usable) → copiar código sería una trampa legal.
`swarm-office` es una implementación clean-room e independiente bajo MIT. WorkAdventure se usa como
referencia de la experiencia de voz-proximidad (no de código).

## 4. Stack y rationale

| Capa | Tecnología | Por qué |
|------|-----------|---------|
| Render cliente | **Phaser 4** (WebGL) | Motor 2D estándar sobre GPU; pixel-art trivial a 60fps. Rust/C no batirían a la GPU aquí. Migrado de Phaser 3.90 → 4.2 el 2026-06-22 (v4 estable abr-2026; usamos solo APIs estándar → migración sin cambios de código; ESM modular). Ver nota abajo |
| Shell UI | **Vite + React** | SPA ligera (Next solo si luego se quiere landing/SSR) |
| Multiplayer | **Colyseus** | Servidor autoritativo con rooms + **sync de estado por schema (binario, delta)** + base para interest management. Mejora el punto débil de DeskRPG (Socket.IO crudo) |
| Voz/vídeo (F1) | **LiveKit** (self-host) | Audio/vídeo por proximidad open-source. (Coturn/TURN para NAT) |
| Persistencia | **Postgres + Drizzle** | Mapas, usuarios, layouts |
| Mapas | **Tiled** | Editor de tilemaps estándar |
| Agentes NPC (F2) | hook al **gateway M.IA** | Agentes como NPCs con los que el equipo habla |

### Nota — migración Phaser 3 → 4 (2026-06-22)
La spec original fijaba Phaser 3. Tras `/improve` se revisó Phaser 4 (estable abr-2026,
[migration guide](https://github.com/phaserjs/phaser/blob/master/changelog/v4/4.0/MIGRATION-GUIDE.md)):
mantiene casi toda la API pública de v3; los breaking changes están solo en renderer
custom, tint, FX/masks, Shader API, lighting y clases retiradas (`Point`/`Mesh`/`BitmapMask`),
**nada de lo cual usamos**. El bump v3.90→4.2 pasó build + runtime (WebGL) **sin tocar código**.
Se eligió migrar ahora, con la superficie mínima (1 slice), para no acumular deuda.

### Nota — modelo de autoridad (Slice 2, 2026-06-22)
Colyseus es autoritativo sobre el **estado de la sala** (quién está presente, las
posiciones canónicas en `OfficeState.players`), pero **no simula el movimiento**:
cada cliente calcula la posición de su propio avatar localmente (física Arcade,
respuesta instantánea) y la *empuja* con `room.send("move")`; el servidor la guarda
y Colyseus difunde el delta binario (~20Hz). Los avatares remotos se **interpolan**
en el cliente (lerp-to-latest) para suavizar el salto entre el tick del servidor y
los 60fps de render. Es el patrón "presence relay" estándar (Gather/WorkAdventure).
La **autoridad total** (cliente manda input → servidor simula → cliente reconcilia,
necesaria para anti-cheat) se difiere a F3.

### Notas de rendimiento (para no malgastar esfuerzo)
- El cuello de botella NO es el render (Phaser = GPU), sino **la red al escalar**.
- Optimización por orden de ROI: **arquitectura** (AOI/interest management, protocolo binario+delta,
  tick bajo + interpolación) → drop-in (uWebSockets/WebRTC) → servidor nativo Rust → cliente
  Bevy/WASM. "Medir antes de reescribir": pasar el render a Rust/C no aporta.

## 5. Roadmap

- **F0 — MVP (en curso, multi-sesión)**: cliente Phaser + servidor Colyseus + Postgres. Walk,
  presencia de jugadores, zonas, chat de texto. Correr **en local** primero.
  Por slices verticales: Slice 1 = scaffold cliente + player local (hecho); Slice 2 =
  servidor Colyseus + presencia (remotos interpolados) (hecho); Slice 3 = zonas
  (servidor posee la pertenencia vía `player.zone`, cliente dibuja las áreas) (hecho);
  Slice 4 = chat de texto. (Postgres se añade cuando haya estado que persistir.)
- **F1 — Voz/vídeo**: LiveKit proximidad + coturn.
- **F2 — Agentes IA como NPCs**: hook al gateway M.IA; un agente Predicta aparece y conversa.
- **F3 — Escala y producto**: interest management (AOI), editor de mapas Tiled, OIDC/members area.

## 6. Despliegue (más adelante, NO ahora)

Secuencia: **local F0 → GCP cuando haya algo desplegable**. No se provisiona infra hasta que exista
un build hosteable (una VM vacía facturando es puro desperdicio).

Cuando toque: **1 GCE VM** con Docker Compose (Traefik + Let's Encrypt TLS + Colyseus + Postgres +
LiveKit). HTTPS obligatorio para WebRTC. Escala → separar LiveKit/coturn a su propia máquina, o
Cloud Run (stateless) + Cloud SQL. Proyecto GCP a decidir (candidato: `ytt-mia` o `ytt-office` nuevo).

## 7. Decisiones abiertas

- [ ] Proyecto GCP para el deploy (ytt-mia vs nuevo) — se decide en F-deploy, no ahora.
- [ ] Dominio (ej. `oficina.yourtechtribe.com`) + gestión DNS.
- [ ] Control de acceso del MVP (enlace abierto al equipo vs gate/OIDC).
- [ ] Assets pixel-art (tileset/sprites): set propio vs pack con licencia compatible.

## 8. Origen

Surgió de una self-note del inbox (repo `pixel-agents`) → investigación dirigida por Albert sobre
(a) tecnología pixel-art 2D para sus juegos (agent-civ) y (b) recrear el Gather de YTT. Nota de
investigación de respaldo: `personal/games/INVESTIGACION-pixel-office-agent-civ-y-gather-ytt.md`.
