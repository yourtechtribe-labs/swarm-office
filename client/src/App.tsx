import { useEffect, useRef, useState } from 'react';
import { PhaserGame, type PhaserGameRef } from './game/PhaserGame';
import { EventBus } from './game/EventBus';
import { Chat } from './Chat';
import { VoiceControls } from './VoiceControls';
import { ServerLog } from './ServerLog';
import { Files } from './Files';
import './App.css';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  App — the React shell (UI overlay around the game canvas)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * React owns the DOM UI (here: a small HUD); Phaser owns the canvas. They never
 * call each other directly — React subscribes to gameplay events on the EventBus.
 * This is the "continuous game time → discrete UI events" translation: the game
 * loop runs at 60 Hz, but React only needs to know when something *changes*
 * (OfficeScene already throttles 'player-moved' to actual position changes).
 *
 * As the game grows, this shell is where login/name entry, the chat panel, and
 * zone indicators will live — all driven by bus events, not by reaching into
 * Phaser.
 */
function App() {
  // Handle to the game instance (exposed by PhaserGame). Not load-bearing yet.
  const phaserRef = useRef<PhaserGameRef>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [present, setPresent] = useState(0);
  const [zone, setZone] = useState('');

  useEffect(() => {
    // Subscribe to the typed bus. Payload types are inferred from SwarmEvents.
    const onMove = (p: { x: number; y: number }) => setPos(p);
    const onPresence = (count: number) => setPresent(count);
    const onZone = (zoneName: string) => setZone(zoneName);
    EventBus.on('player-moved', onMove);
    EventBus.on('presence-changed', onPresence);
    EventBus.on('zone-changed', onZone);
    // Cleanup is REQUIRED: without off(), StrictMode's double-mount (and any
    // future remount) would stack duplicate listeners → leak + multiple setState.
    return () => {
      EventBus.off('player-moved', onMove);
      EventBus.off('presence-changed', onPresence);
      EventBus.off('zone-changed', onZone);
    };
  }, []);

  return (
    <div className="app">
      <PhaserGame ref={phaserRef} />
      <div className="hud">
        <strong className="hud__title">swarm-office</strong>
        <span className="hud__line">F0 · presence</span>
        <span className="hud__line">
          x:{pos.x} y:{pos.y}
        </span>
        <span className="hud__line">in office: {present}</span>
        <span className="hud__line">zone: {zone || '—'}</span>
        <span className="hud__hint">WASD / arrows to move · C to chat · Esc to exit</span>
      </div>
      <VoiceControls />
      <Chat />
      <ServerLog />
      <Files />
    </div>
  );
}

export default App;
