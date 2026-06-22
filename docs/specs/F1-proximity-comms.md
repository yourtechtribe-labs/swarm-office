# F1 — Proximity Communications (zone text + distance voice)

> Spec / specify phase. Status: **draft for review** (specify → plan gate).
> Date: 2026-06-22. Author: Albert Gil López + Claude. Supersedes the one-line F1
> entry in `docs/SPEC.md` §5.

## 1. Goal

Make the office feel alive to talk in, mirroring a real workspace:

- **Text is broad (the room's channel):** if you write, everyone **in your zone**
  reads it.
- **Voice is intimate (you walk up to someone):** you hear/are heard **only when
  you get physically close** to another avatar.

Audio only, peer-to-peer (no media server), **up to ~5 simultaneous users**.

## 2. Scope

**In:**
- **F1a — zone-scoped text chat.** Change the existing (global) chat so a message
  reaches only avatars in the **same zone** as the sender.
- **F1b — distance-gated voice.** Audio-only WebRTC **mesh** between all present
  clients; each remote is **audible only while within a proximity radius**.

**Out / deferred (named explicitly — no silent caps):**
- **Video** (cameras, tiles) → F1.x.
- **Scale beyond ~5–6** → a pure mesh tops out at 4–6 peers (each peer up/down-links
  to every other). Beyond that needs an SFU (LiveKit) — out of scope by decision.
- **Graduated volume-by-distance** (volume falls smoothly with distance) → F1.x; v1
  is a **binary** audible/not at the radius, which is what "talk if you approach"
  asks for.
- **TURN server** (cross-NAT / symmetric-NAT traversal) → deploy-time infra. v1 uses
  public **STUN** only → works on LAN / basic NAT; cross-NAT won't connect until a
  TURN server exists. Stated, not silently assumed.
- **Chat history / persistence** → still transient (as in Slice 4).

## 3. Sub-slices & sequencing

Build **F1a first** (small, low-risk, reuses everything) then **F1b** (the real
work: WebRTC). Ship value early, isolate the risk.

---

## 4. F1a — Zone-scoped text chat

**Change:** today `OfficeRoom` does `this.broadcast('chat', …)` (everyone). Make it
a **filtered send**: deliver only to clients whose `player.zone` equals the
sender's zone. The data already exists — `player.zone` is computed authoritatively
on join + every move (Slice 3).

```
// server, onMessage('chat'): after validation
const senderZone = this.state.players.get(client.sessionId)?.zone ?? '';
for (const c of this.clients) {
  if ((this.state.players.get(c.sessionId)?.zone ?? '') === senderZone) {
    c.send('chat', { from: client.sessionId, text: capped });
  }
}
```

**Edge cases (decided):**
- **No-zone hub** (`zone === ''`): people in no zone form **one** group together
  (`'' === ''` matches). Simplest and intuitive (the open floor is itself a channel).
- **Self echo:** the sender always matches its own zone, so it still receives its own
  line — no special case needed; the single receive→render path (Slice 4) is intact.

**Client:** unchanged. (Optional polish: the HUD already shows the current zone, so
the user knows the reach of what they type.)

**Validation:** A and B in the same zone → B receives A's line; move B to another
zone → B no longer receives A's lines; a third client in the hub gets hub-only
messages. Assert via the two-tab DOM harness (cross-tab text match), as in Slice 4.

---

## 5. F1b — Distance-gated voice (WebRTC P2P mesh, audio-only)

### 5.1 Core model — connections follow PRESENCE, audio follows DISTANCE

The naive approach (open a PeerConnection when near, close it when far) is the
painful path: a `RTCPeerConnection` handshake (ICE + DTLS) costs hundreds of ms to
seconds, so boundary oscillation → connect/teardown storms, and walking up to
someone has an awkward "wait to connect" gap.

Instead:
- **Connection lifecycle = presence.** Open **one `RTCPeerConnection` per remote
  peer** when they appear and close it when they leave — the *exact* lifecycle
  already built for `RemotePlayer` (onAdd → create, onRemove → close). A parallel
  `peers: Map<sessionId, VoicePeer>`.
- **Audibility = distance, per frame.** Proximity is a cheap boolean: within radius
  → `remoteAudioTrack.enabled = true` (unmute); outside → `false`. Flipping a flag
  is free, so boundary flapping is a non-issue and approaching gives **instant**
  audio. (This also means we always have a live connection ready; the gate is the
  mute, not the link.)

> Decision: connect-to-all-present + distance-gated `track.enabled`. With ≤5 that's
> ≤4 peer connections per client — well within mesh limits.

### 5.2 One PeerConnection per peer + Perfect Negotiation (glare)

Both sides see each other's `onAdd` and would each try to create an offer →
**glare** (two offers colliding). We use the **Perfect Negotiation** pattern
(WebRTC spec / MDN): symmetric code on both sides, one peer **polite**, one
**impolite**, decided deterministically per pair by lexicographic `sessionId`
compare (e.g. the lexicographically smaller sessionId is impolite/initiator). On an
offer collision the polite peer rolls back and accepts the incoming offer. One PC
per `sessionId`, never two.

Refs: [MDN Perfect Negotiation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation),
[Mozilla WebRTC blog](https://blog.mozilla.org/webrtc/perfect-negotiation-in-webrtc/).

### 5.3 Signaling over Colyseus

WebRTC doesn't define signaling — we reuse the room's WebSocket. A new relayed
message type carries SDP offers/answers and ICE candidates between two specific
clients:

```
client → server:  room.send('signal', { to: <sessionId>, data: <SDP|ICE> })
server  → client:  c.send('signal', { from: <sessionId>, data })   // c == the `to` peer
```

The **server only relays** (no media touches it). It **stamps `from` itself** from
`client.sessionId` (never trusts a client-provided `from`) — same anti-spoof
discipline as chat. Lookup: `this.clients.find(c => c.sessionId === to)?.send(...)`.

### 5.4 Microphone + autoplay → an explicit "Join voice" gesture

Browsers block both silent `getUserMedia` and autoplay audio without a user
gesture. So F1b requires a **"Join voice" button**: one click that (a) requests the
mic (`getUserMedia({ audio: true })`) and (b) unlocks remote audio playback. This
is the unlock mechanism, not optional chrome. Until clicked, the client is
presence+chat only (no voice), which is a fine default.

### 5.5 ICE: STUN now, TURN deferred

Use a public STUN server (`stun:stun.l.google.com:19302`) so peers can discover
their public address — works on LAN and basic NAT. **Cross-NAT / symmetric-NAT
won't connect until a TURN server is added** (deploy-time infra). Stated explicitly.

### 5.6 Audio playback

Each remote peer's incoming track (`pc.ontrack`) is attached to a hidden
`<audio autoplay>` element (created per peer, removed on leave). The distance gate
toggles `track.enabled` (or the element's muted/volume). One element per remote.

### 5.7 Bus & wiring (keeps "React never touches the network/media directly")

- React "Join voice" button → `EventBus.emit('voice-join')` → scene starts voice
  (getUserMedia, mark joined).
- Scene owns the `peers` map + the room signaling, exactly like presence/chat.
- Scene → React status events (e.g. `voice-state`: joined? mic error?) for the
  button/UI.

## 6. Security

- **Token/identity:** none added — identity stays the server-stamped `sessionId`.
- **Signaling is relayed through the trusted server**, `from` stamped server-side.
- **No media server to secure**; media is P2P, encrypted by WebRTC (DTLS-SRTP) by
  default.
- **Mic is browser-gated** (explicit permission). For a ≤5 trusted office this is
  sufficient; access control (who may join voice) can come with the members area (F3).

## 7. Validation strategy

- **Fake media for automation:** the deterministic two-tab harness can't grant a
  real mic. Launch the debug Chrome with `--use-fake-device-for-media-stream`
  **and** `--use-fake-ui-for-media-stream` so `getUserMedia` auto-resolves a fake
  audio track with no prompt.
- **Assert (not "we heard audio" — can't, and won't fake):**
  - F1a: cross-tab text reaches same-zone only (DOM match), not other zones.
  - F1b: after both click Join, for each pair `pc.connectionState === 'connected'`;
    a remote audio track is present in `pc.getReceivers()`; moving within the radius
    flips the remote track's `enabled` true, moving out flips it false (read the
    flag, asserted like the Slice-2 position convergence).

## 8. Acceptance criteria

- [ ] A message typed in zone X is received by all clients in zone X and **no
      others**; hub (`''`) is its own group.
- [ ] Two clients who both clicked "Join voice" establish a connected
      `RTCPeerConnection` (per-pair, single PC, no glare errors).
- [ ] A remote becomes audible (`track.enabled === true`) when within the radius and
      muted when outside; toggling is instant (no reconnect).
- [ ] Connections open on peer join and close on peer leave (no leaks; mirrors
      `RemotePlayer` lifecycle).
- [ ] Mic prompt happens only after the explicit "Join voice" gesture.
- [ ] Build green both sides; didactic comments document the WebRTC flow.

## 9. Files (anticipated — confirmed at /plan)

**Server:** `OfficeRoom.ts` — filter chat by zone (F1a); add `onMessage('signal')`
relay stamping `from` (F1b).

**Client:** `net/room.ts` — `signal` message types; `game/scenes/OfficeScene.ts` —
`peers` map lifecycle + per-frame distance gate; new `net/VoicePeer.ts` — one
peer's `RTCPeerConnection` + perfect negotiation + audio element (the voice "seam",
analogous to `RemotePlayer`); `EventBus.ts` — `voice-join` / `voice-state`; a "Join
voice" control in React.

## 10. Open questions for /plan

- Proximity radius value (px) — tune empirically; start ~180 (a bit under a zone).
- Whether voice is additionally constrained to same-zone, or pure distance
  regardless of zone (current spec: **pure distance**, simplest; zone governs text).
- Polite/impolite tie-break rule wording (lexicographic sessionId) — confirm.
