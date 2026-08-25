const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));

// ---- ゲーム状態（シングルルーム） ----
const players = new Map(); // socketId -> { name, score }
let hostId = null;
let phase = 'idle'; // idle | open | buzzed
let buzzedId = null;
const lockedOut = new Set(); // このお題で誤答済みのplayerId

function publicPlayers() {
  return [...players.entries()].map(([id, p]) => ({
    id,
    name: p.name,
    score: p.score,
    locked: lockedOut.has(id),
  }));
}

function broadcastState() {
  io.emit('state', {
    phase,
    players: publicPlayers(),
    buzzedId,
    buzzedName: buzzedId ? players.get(buzzedId)?.name : null,
    hasHost: hostId !== null,
  });
}

io.on('connection', (socket) => {
  socket.on('join', ({ name, role }) => {
    if (role === 'host') {
      hostId = socket.id;
      socket.data.role = 'host';
    } else {
      const cleanName = (name || '').toString().trim().slice(0, 20) || `プレイヤー${socket.id.slice(0, 4)}`;
      players.set(socket.id, { name: cleanName, score: 0 });
      socket.data.role = 'player';
    }
    broadcastState();
  });

  socket.on('host:open', () => {
    if (socket.id !== hostId) return;
    phase = 'open';
    buzzedId = null;
    broadcastState();
  });

  socket.on('host:reset', () => {
    if (socket.id !== hostId) return;
    phase = 'idle';
    buzzedId = null;
    lockedOut.clear();
    broadcastState();
  });

  socket.on('host:correct', () => {
    if (socket.id !== hostId || !buzzedId) return;
    const p = players.get(buzzedId);
    if (p) p.score += 1;
    phase = 'idle';
    buzzedId = null;
    lockedOut.clear();
    broadcastState();
  });

  socket.on('host:wrong', () => {
    if (socket.id !== hostId || !buzzedId) return;
    lockedOut.add(buzzedId);
    buzzedId = null;
    phase = 'open';
    broadcastState();
  });

  socket.on('player:buzz', () => {
    if (phase !== 'open') return;
    if (!players.has(socket.id)) return;
    if (lockedOut.has(socket.id)) return;
    phase = 'buzzed';
    buzzedId = socket.id;
    broadcastState();
  });

  socket.on('disconnect', () => {
    if (socket.id === hostId) {
      hostId = null;
    }
    if (players.has(socket.id)) {
      players.delete(socket.id);
      lockedOut.delete(socket.id);
      if (buzzedId === socket.id) {
        buzzedId = null;
        phase = 'idle';
      }
    }
    broadcastState();
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`早押しクイズサーバー起動: http://localhost:${PORT}`);
});
