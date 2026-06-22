/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  VoicePeer — one WebRTC audio connection to one remote peer (the voice seam)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Analogous to RemotePlayer (the render seam): one instance per remote peer,
 * created when they appear and closed when they leave. Where RemotePlayer owns a
 * sprite, VoicePeer owns an RTCPeerConnection + an <audio> sink.
 *
 * THE BIG IDEA (why this is robust): connection follows PRESENCE, audio follows
 * DISTANCE. The peer connection stays alive the whole time the peer is present; the
 * proximity gate only flips audioEl.muted (a free boolean) — so walking up to
 * someone gives INSTANT audio with no connect/teardown churn.
 *
 * WHAT WebRTC IS DOING UNDER THE HOOD
 * -----------------------------------
 * WebRTC sends media peer-to-peer (the audio never touches our server). To set up
 * a direct connection across the internet, two peers must first agree on:
 *   - codecs / media params → exchanged as SDP "offer" and "answer" (session
 *     descriptions);
 *   - network paths → exchanged as ICE "candidates" (ip:port routes; STUN tells a
 *     peer its own public address behind NAT).
 * That exchange is "signaling", which WebRTC leaves to us — we tunnel it through
 * the Colyseus room (see OfficeScene + the server 'signal' relay). Once both sides
 * have each other's SDP + a working ICE candidate pair, media flows directly,
 * encrypted (DTLS-SRTP) automatically.
 *
 * PERFECT NEGOTIATION (the glare problem)
 * ---------------------------------------
 * Both peers see each other appear and both call addTrack → both fire
 * onnegotiationneeded → both send an offer at once = "glare", which corrupts the
 * handshake. The spec's "perfect negotiation" pattern makes the code symmetric and
 * breaks the tie with roles: exactly one peer of each pair is "polite". On an offer
 * collision the polite peer rolls back and accepts the other's offer; the impolite
 * peer ignores the incoming offer and keeps its own. Role is decided deterministically
 * by the scene (lexicographic sessionId compare), so the two ends always disagree on
 * who is polite — which is exactly what resolves the collision.
 * Ref: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation
 */

/** STUN lets a peer discover its public address behind NAT. TURN (relay for
 *  symmetric NAT / firewalls) is deploy-time infra, deferred — so cross-NAT peers
 *  won't connect yet; LAN / basic NAT will. */
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/** An opaque signaling blob: either an SDP description or an ICE candidate. */
export type SignalData = {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

export class VoicePeer {
  private readonly pc: RTCPeerConnection;
  private readonly audioEl: HTMLAudioElement;
  // Perfect-negotiation bookkeeping (see handleSignal).
  private makingOffer = false;
  private ignoreOffer = false;
  // Last audibility we applied, so the per-frame gate only touches the media
  // element on an actual change (see setAudible).
  private audible = false;
  // Declared as fields (not constructor parameter-properties): TS's
  // `erasableSyntaxOnly` (a Vite default) forbids parameter properties because
  // they emit runtime assignments rather than being pure type-erasure.
  private readonly polite: boolean;
  private readonly sendSignal: (data: SignalData) => void;

  /**
   * @param polite  true if THIS side is the polite peer for this pair (decided by
   *                the scene via sessionId compare; exactly one side is polite).
   * @param sendSignal  sends an opaque blob to this peer (scene → room 'signal').
   * @param localStream our mic, if we've already joined voice (else null → no
   *                    track yet; addLocalStream is called later on join).
   */
  constructor(
    polite: boolean,
    sendSignal: (data: SignalData) => void,
    localStream: MediaStream | null,
  ) {
    this.polite = polite;
    this.sendSignal = sendSignal;
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Hidden sink for this peer's incoming voice. Starts muted; the per-frame
    // distance+zone gate (OfficeScene) unmutes it when the peer is audible.
    this.audioEl = document.createElement('audio');
    this.audioEl.autoplay = true;
    this.audioEl.muted = true;
    document.body.appendChild(this.audioEl);

    // Fired whenever this connection needs a new offer (e.g. we added our mic).
    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        // Modern no-arg form: creates an offer (or answer) appropriate to state.
        await this.pc.setLocalDescription();
        this.sendSignal({ description: this.pc.localDescription! });
      } catch (err) {
        console.error('[voice] negotiation error', err);
      } finally {
        this.makingOffer = false;
      }
    };

    // Our ICE candidates (network routes) → send to the peer as we discover them.
    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.sendSignal({ candidate: candidate.toJSON() });
    };

    // The peer added a track → route its stream to our audio sink.
    this.pc.ontrack = ({ streams }) => {
      this.audioEl.srcObject = streams[0] ?? null;
    };

    if (localStream) this.addLocalStream(localStream);
  }

  /** Add our mic to this connection → triggers onnegotiationneeded → offer. */
  addLocalStream(stream: MediaStream): void {
    for (const track of stream.getTracks()) this.pc.addTrack(track, stream);
  }

  /**
   * Handle an incoming signal — the symmetric half of perfect negotiation. The
   * polite/impolite role only matters on an OFFER COLLISION; everything else is
   * the plain "apply remote description / add candidate" flow.
   */
  async handleSignal(data: SignalData): Promise<void> {
    try {
      if (data.description) {
        const desc = data.description;
        // Collision = an incoming offer while we're mid-offer or not stable.
        const offerCollision =
          desc.type === 'offer' &&
          (this.makingOffer || this.pc.signalingState !== 'stable');
        // Impolite peer ignores a colliding offer (keeps its own); polite yields.
        this.ignoreOffer = !this.polite && offerCollision;
        if (this.ignoreOffer) return;
        await this.pc.setRemoteDescription(desc); // implicit rollback if polite & colliding
        if (desc.type === 'offer') {
          await this.pc.setLocalDescription(); // auto-answer
          this.sendSignal({ description: this.pc.localDescription! });
        }
      } else if (data.candidate) {
        try {
          await this.pc.addIceCandidate(data.candidate);
        } catch (err) {
          // A candidate for an offer we deliberately ignored is expected to fail.
          if (!this.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.error('[voice] signal handling error', err);
    }
  }

  /**
   * Distance+zone gate (called per frame by the scene): unmute only when audible.
   * Guarded on change — the scene calls this ~60×/s but audibility flips rarely
   * (you're near someone or not), so we avoid a redundant media-element write every
   * frame. Same change-detection idiom as lastEmit/lastZone in OfficeScene.
   */
  setAudible(audible: boolean): void {
    if (audible === this.audible) return;
    this.audible = audible;
    this.audioEl.muted = !audible;
  }

  // --- inspection helpers (used by the deterministic validation harness) ---
  get connectionState(): RTCPeerConnectionState {
    return this.pc.connectionState;
  }
  hasInboundAudio(): boolean {
    return this.pc.getReceivers().some((r) => r.track?.kind === 'audio');
  }
  isAudible(): boolean {
    return !this.audioEl.muted;
  }

  close(): void {
    this.pc.close();
    this.audioEl.srcObject = null;
    this.audioEl.remove();
  }
}
