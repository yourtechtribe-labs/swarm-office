import { useEffect, useRef, useState } from 'react';
import { PhaserGame, type PhaserGameRef } from './game/PhaserGame';
import { EventBus } from './game/EventBus';
import './App.css';

function App() {
  const phaserRef = useRef<PhaserGameRef>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Subscribe to gameplay events from the Phaser side via the bus (not props).
  useEffect(() => {
    const onMove = (p: { x: number; y: number }) => setPos(p);
    EventBus.on('player-moved', onMove);
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
