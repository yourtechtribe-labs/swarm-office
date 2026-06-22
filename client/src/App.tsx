import { useEffect, useRef, useState } from 'react';
import { PhaserGame, type PhaserGameRef } from './game/PhaserGame';
import { EventBus } from './game/EventBus';
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

  useEffect(() => {
    // Subscribe to the typed bus. The payload type is inferred from SwarmEvents.
    const onMove = (p: { x: number; y: number }) => setPos(p);
    EventBus.on('player-moved', onMove);
    // Cleanup is REQUIRED: without off(), StrictMode's double-mount (and any
    // future remount) would stack duplicate listeners → leak + multiple setState.
    return () => {
      EventBus.off('player-moved', onMove);
    };
  }, []);

  return (
    <div className="app">
      <PhaserGame ref={phaserRef} />
      <div className="hud">
        <strong className="hud__title">swarm-office</strong>
        <span className="hud__line">F0 · local player</span>
        <span className="hud__line">
          x:{pos.x} y:{pos.y}
        </span>
        <span className="hud__hint">WASD / arrows to move</span>
      </div>
    </div>
  );
}

export default App;
