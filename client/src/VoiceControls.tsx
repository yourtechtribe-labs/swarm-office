import { useEffect, useState } from 'react';
import { EventBus } from './game/EventBus';
import './VoiceControls.css';

/**
 * VoiceControls — the "Join voice" gesture (React → scene over the bus).
 *
 * WHY A BUTTON IS LOAD-BEARING, NOT DECORATION
 * --------------------------------------------
 * Browsers block BOTH silent getUserMedia (mic) and audio autoplay until a real
 * user gesture. This click is that gesture: it lets the scene call getUserMedia
 * (capture our mic) AND unlocks playback of the remote peers' audio. Until clicked,
 * the client is presence + chat only — a fine default that asks for no permissions.
 *
 * React only emits the intent ('voice-join'); the scene owns the mic + the WebRTC
 * peer connections (same contract as chat: React never touches media/network).
 */
export function VoiceControls() {
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onState = (s: { joined: boolean; error?: string }) => {
      setJoined(s.joined);
      setError(s.error ?? null);
    };
    EventBus.on('voice-state', onState);
    return () => {
      EventBus.off('voice-state', onState);
    };
  }, []);

  if (joined) {
    return <div className="voice voice--on">🎙 voice on · talk to people near you</div>;
  }

  return (
    <div className="voice">
      <button className="voice__btn" type="button" onClick={() => EventBus.emit('voice-join')}>
        🎙 Join voice
      </button>
      {error && <span className="voice__err">mic blocked</span>}
    </div>
  );
}
