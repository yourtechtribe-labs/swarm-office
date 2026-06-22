import { Scene, Physics, Input, type Types } from 'phaser';
import { EventBus } from '../EventBus';
import {
  connectToOffice,
  getStateCallbacks,
  type OfficeRoom,
  type PlayerView,
  type ZoneView,
} from '../../net/room';
import { RemotePlayer } from '../RemotePlayer';
import { VoicePeer, type SignalData } from '../../net/VoicePeer';

/** World size in pixels. The camera shows a window onto this larger world. */
const WORLD_W = 1600;
const WORLD_H = 1200;
/** Player speed in pixels per second (frame-rate independent — see update()). */
const SPEED = 220;
/** Voice proximity radius (px): a peer is audible only within this AND same zone. */
const VOICE_RADIUS = 200;

type DirKeys = Record<'up' | 'down' | 'left' | 'right', Input.Keyboard.Key>;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  OfficeScene — the playable office (F0 / Slice 1)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Scope (F0, slices 1–4): a tiled floor, the local player (WASD/arrow movement,
 * camera follow), networked PRESENCE (remote players interpolated from the Colyseus
 * server), ZONES (named areas; the server owns membership via player.zone, the
 * client draws the rectangles the server pushes and shows the local player's zone),
 * and CHAT (transient broadcast; React panel ↔ scene ↔ room over the EventBus, with
 * the game keyboard suspended while the chat input is focused).
 *
 * RENDER LAYERS (depth)
 * ---------------------
 * Zones arrive asynchronously (after the player sprite is created), so without
 * explicit depths they'd paint OVER the avatars. We pin three layers:
 *   floor = 0  <  zones = 1 (labels 2)  <  avatars = 10.
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
  /** Zone geometry pushed by the server (for rendering + local membership tests). */
  private zones: ZoneView[] = [];
  /** Last local zone name we emitted, so we notify React only on change. */
  private lastZone = '';
  /** True while the chat input is focused — suspends local movement (see update). */
  private chatFocused = false;
  /** One WebRTC audio connection per remote peer (voice seam), keyed by sessionId. */
  private readonly peers = new Map<string, VoicePeer>();
  /** Our microphone stream once joined (undefined until the "Join voice" gesture). */
  private localStream?: MediaStream;
  /** True after the user joined voice (unlocks mic capture + audio autoplay). */
  private hasJoinedVoice = false;

  constructor() {
    super('OfficeScene');
  }

  create() {
    // FLOOR: one big TileSprite (1600×1200) that REPEATS a 32×32 texture. It is a
    // single quad, not ~1875 sprites: the GPU sampler's REPEAT wrap mode tiles the
    // texture across UVs that run 0→50 (1600/32). One draw call for the whole
    // floor. setOrigin(0,0) anchors its top-left at world (0,0) (default is center).
    this.add.tileSprite(0, 0, WORLD_W, WORLD_H, 'floor').setOrigin(0, 0).setDepth(0);

    // The physics world's bounds; bodies with collideWorldBounds clamp to these.
    this.physics.world.setBounds(0, 0, WORLD_W, WORLD_H);

    // PLAYER: physics.add.sprite creates the sprite AND attaches an Arcade Body.
    // The sprite follows the body: each frame the body integrates its position and
    // copies it to the sprite. We therefore steer the body (setVelocity), not the
    // sprite's x/y directly.
    this.player = this.physics.add.sprite(WORLD_W / 2, WORLD_H / 2, 'player');
    this.player.setScale(2);
    this.player.setCollideWorldBounds(true);
    this.player.setDepth(10); // avatar layer, above the zone overlays

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

    // CHAT bus wiring (React → scene). The scene owns the room, so React emits
    // intents on the bus and we relay them — React never touches the network.
    // Registered here and removed on scene 'shutdown' so a StrictMode/HMR teardown
    // doesn't leak listeners or leave stale closures pointing at a dead scene.
    const onChatSend = (text: string) => this.room?.send('chat', { text });
    const onChatFocus = (focused: boolean) => {
      this.chatFocused = focused;
      const kb = this.input.keyboard!;
      // Disable Phaser's keyboard so WASD typed into the chat box doesn't move the
      // avatar; and zero velocity so a key held at the moment of focus doesn't keep
      // sliding it (disabling only stops UPDATES, not the frozen isDown state).
      // NOTE: chat is the ONLY keyboard-capturing UI today, so this absolute
      // enable/disable is fine. If a second focusable input is added (name entry,
      // settings), this last-writer-wins flag will race on focus transfer — at that
      // point generalize to an "any-reason-suspends" owner (a set of capture
      // reasons), not a second competing boolean. Not built now (premature).
      kb.enabled = !focused;
      // …BUT `enabled = false` is NOT enough on its own. createCursorKeys()/addKey()
      // registered WASD + arrows + space for GLOBAL CAPTURE, so Phaser's
      // KeyboardManager calls preventDefault on those keycodes at the window level —
      // and it keeps doing so even while the plugin is disabled. Net effect (the
      // reported bug): typing a / d / w / s / space into the chat box did nothing,
      // because those keystrokes were swallowed before they reached the <input>.
      // Two separate capture lists exist — the per-scene plugin's and the global
      // KeyboardManager's — and the preventDefault lives on the MANAGER, which
      // `enabled` doesn't gate. disableGlobalCapture() lifts that preventDefault so
      // the characters reach the box; enableGlobalCapture() restores it on blur so
      // gameplay keys don't scroll the page. (Phaser's documented fix for "typing in
      // an input box".)
      if (focused) kb.disableGlobalCapture();
      else kb.enableGlobalCapture();
      if (focused) this.player.setVelocity(0);
    };
    // VOICE JOIN (F1b): the "Join voice" gesture from React. getUserMedia here is
    // what unlocks BOTH mic capture and audio autoplay (browsers require a user
    // gesture). On success we add our mic to every already-open peer connection,
    // which triggers WebRTC (re)negotiation. Denial degrades gracefully (no voice).
    const onVoiceJoin = async () => {
      if (this.hasJoinedVoice) return;
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.hasJoinedVoice = true;
        for (const peer of this.peers.values()) peer.addLocalStream(this.localStream);
        EventBus.emit('voice-state', { joined: true });
      } catch (err) {
        console.error('[voice] could not get microphone', err);
        EventBus.emit('voice-state', { joined: false, error: String(err) });
      }
    };

    EventBus.on('chat-send', onChatSend);
    EventBus.on('chat-focus', onChatFocus);
    EventBus.on('voice-join', onVoiceJoin);
    this.events.once('shutdown', () => {
      EventBus.off('chat-send', onChatSend);
      EventBus.off('chat-focus', onChatFocus);
      EventBus.off('voice-join', onVoiceJoin);
      // Tear down all peer connections + stop the mic on scene teardown
      // (StrictMode/HMR) so we don't leak connections or keep the mic hot.
      for (const peer of this.peers.values()) peer.close();
      this.peers.clear();
      this.localStream?.getTracks().forEach((t) => t.stop());
    });
  }

  /**
   * Wire the room's state callbacks once we've joined. This is where the "player
   * seam" pays off: the server's players map drives spawn/despawn of RemotePlayer
   * instances, while our own avatar stays the local Arcade sprite.
   */
  private onConnected(room: OfficeRoom) {
    this.room = room;

    // Register the "zones" handler FIRST — synchronously, before any awaited work.
    // The server pushes the zone geometry in onJoin; registering the handler in the
    // same call stack as the join-resolve wins the race against that in-flight
    // message (the message is still travelling over the wire while this runs).
    room.onMessage('zones', (zones: ZoneView[]) => this.renderZones(zones));

    // Server → React: a chat line arrived (transient broadcast, not state). Relay
    // it onto the bus, marking our own lines (echoed back to us) by comparing the
    // sender's sessionId to ours. React listens on the bus, never on the room.
    room.onMessage('chat', (msg: { from: string; text: string }) => {
      // Resolve the author's display name from synced state. The server stamps `from`
      // as a sessionId / NPC key (anti-spoof); the human-readable name lives on the
      // Player schema (the NPC sets "M.IA"; humans are '' for now). Reading it here
      // keeps the wire message tiny (no name duplicated per line) and works for any
      // future human names with no further change.
      const name = room.state.players.get(msg.from)?.name ?? '';
      EventBus.emit('chat-message', {
        from: msg.from,
        name,
        text: msg.text,
        self: msg.from === room.sessionId,
      });
    });

    // VOICE SIGNALING (F1b): the server relays SDP/ICE blobs between peers; route
    // each to the matching VoicePeer's perfect-negotiation handler. `from` is the
    // server-stamped sessionId, so it reliably maps to a peer in our map.
    room.onMessage('signal', (msg: { from: string; data: SignalData }) => {
      this.peers.get(msg.from)?.handleSignal(msg.data);
    });

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
      // Mark an AI NPC with a floating name label so a human reads it as an agent.
      // Humans pass no label (their name HUD lives elsewhere); only NPCs are tagged.
      const remote = new RemotePlayer(this, player.x, player.y, player.isNpc ? player.name : undefined);
      this.remotes.set(sessionId, remote);
      // Each time the server updates this remote, repoint its interpolation target.
      $(player).onChange(() => remote.setTarget(player.x, player.y));

      // VOICE SEAM (F1b): open a WebRTC connection to this peer NOW (connections
      // follow presence, audio follows distance). Perfect-negotiation role: exactly
      // one side of each pair is "polite", decided by lexicographic sessionId
      // compare so the two ends always disagree (which is what resolves glare).
      // Pass our mic if we've already joined voice; otherwise it's added on join.
      //
      // F2: an NPC is a state.players entry with NO browser behind it, so a VoicePeer
      // to it would never connect (a dead PeerConnection that hangs in negotiation).
      // We gate peer creation on the synced isNpc flag and skip NPCs — the voice mesh
      // stays human-only. (The other two peer touch-points need no guard: onRemove's
      // cleanup and the per-frame proximity gate both iterate `this.peers`, so an NPC
      // with no peer entry is excluded for free.)
      if (!player.isNpc) {
        const polite = room.sessionId > sessionId;
        const peer = new VoicePeer(
          polite,
          (data) => room.send('signal', { to: sessionId, data }),
          this.localStream ?? null,
        );
        this.peers.set(sessionId, peer);
      }
    });

    // A player left: despawn its avatar.
    $(room.state).players.onRemove((_player: PlayerView, sessionId: string) => {
      this.remotes.get(sessionId)?.destroy();
      this.remotes.delete(sessionId);
      // Tear down the voice connection too (connections follow presence).
      this.peers.get(sessionId)?.close();
      this.peers.delete(sessionId);
      emitPresence();
    });
  }

  /**
   * Draw the zone rectangles + labels the server pushed. Rectangles are pure GPU
   * geometry (no texture); we layer them between the floor (0) and avatars (10).
   * A Rectangle's origin is its CENTER, so we position it at the rect's midpoint.
   */
  private renderZones(zones: ZoneView[]) {
    this.zones = zones;
    for (const z of zones) {
      this.add
        .rectangle(z.x + z.w / 2, z.y + z.h / 2, z.w, z.h, z.color, 0.12)
        .setStrokeStyle(2, z.color, 0.5)
        .setDepth(1);
      this.add
        .text(z.x + 10, z.y + 8, z.name, { fontSize: '20px', color: '#e6edf3' })
        .setDepth(2);
    }

    // Zones arrive asynchronously, possibly AFTER the player has spawned and is
    // standing still. The per-frame zone check (update step 5) only runs on
    // movement, so without this one-shot a stationary player who spawned inside a
    // zone would show no zone until they first move. Compute it once now that the
    // geometry exists.
    this.setLocalZone(this.player.x, this.player.y);
  }

  /**
   * Display name of the zone containing (x,y), or '' if none. Same point-in-rect
   * test the server uses — duplicated here only as the trivial predicate (the zone
   * DATA stays single-sourced from the server) so the local HUD is lag-free.
   */
  private localZoneName(x: number, y: number): string {
    for (const z of this.zones) {
      if (x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) return z.name;
    }
    return '';
  }

  /**
   * Compute the local player's zone for (x,y) and emit 'zone-changed' only on an
   * actual enter/leave. Shared by the two triggers of a zone change: the player
   * moving (update) and the zone geometry arriving (renderZones) — keeping the
   * change-detection in one place so the emit contract can't drift between them.
   */
  private setLocalZone(x: number, y: number) {
    const zoneName = this.localZoneName(x, y);
    if (zoneName !== this.lastZone) {
      this.lastZone = zoneName;
      EventBus.emit('zone-changed', zoneName);
    }
  }

  update() {
    // 1) READ INPUT — combine arrows and WASD with OR. While the chat input is
    // focused, force every direction false so the avatar can't move: the game
    // keyboard is also disabled in onChatFocus, but this additionally neutralizes a
    // key whose isDown froze true at the instant focus left the canvas (otherwise
    // the avatar would slide forever). Remotes still interpolate below (step 6).
    const typing = this.chatFocused;
    const left = !typing && (this.cursors.left.isDown || this.wasd.left.isDown);
    const right = !typing && (this.cursors.right.isDown || this.wasd.right.isDown);
    const up = !typing && (this.cursors.up.isDown || this.wasd.up.isDown);
    const down = !typing && (this.cursors.down.isDown || this.wasd.down.isDown);

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

      // 5) LOCAL ZONE (instant, client-side): which zone is our own avatar in?
      // Computed INSIDE the position-changed guard: zone membership is a pure
      // function of (x,y), so while standing still it cannot change — no point
      // re-running the point-in-rect scan ~60×/s on idle frames (the common case
      // in a presence app). Lag-free HUD (relay philosophy: our own derived state
      // is instant); REMOTES' zones come from the synced schema (player.zone) the
      // server computes. Emit only on actual enter/leave (handled in setLocalZone).
      this.setLocalZone(x, y);
    }

    // 6) INTERPOLATE REMOTES every frame: ease each remote avatar toward its last
    // server-reported position. Runs unconditionally (not throttled) because the
    // smoothing must happen on frames where no new server update arrived — that's
    // the whole point of bridging the ~20Hz server tick to ~60Hz rendering.
    for (const remote of this.remotes.values()) {
      remote.interpolate();
    }

    // 7) VOICE PROXIMITY GATE (F1b): a remote is audible iff we've joined voice AND
    // they share our zone AND they're within VOICE_RADIUS. Three existing data
    // sources combined into one per-frame boolean; the WebRTC connection stays up,
    // we only flip mute — so approaching gives INSTANT audio with no reconnect.
    // Zone + positions come from the synced schema (authoritative for everyone), so
    // both ends agree on who can hear whom.
    if (this.hasJoinedVoice && this.room) {
      const me = this.room.state.players.get(this.room.sessionId);
      if (me) {
        for (const [sid, peer] of this.peers) {
          const other = this.room.state.players.get(sid);
          const audible =
            !!other &&
            other.zone === me.zone &&
            Math.hypot(other.x - me.x, other.y - me.y) < VOICE_RADIUS;
          peer.setAudible(audible);
        }
      }
    }
  }
}
