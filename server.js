const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');
const fs = require('fs');

const PORT = Number(process.env.PORT) || 3000;   // Render/Railway inyectan PORT
const HOST = '0.0.0.0';
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const IS_HOSTED = Boolean(process.env.RENDER || process.env.RAILWAY_ENVIRONMENT);
const OFFLINE_GRACE_MS = 60_000;                  // tiempo de gracia antes de borrar en el lobby

const app = express();
app.set('trust proxy', 1);                        // estamos detrás de un proxy HTTPS
const server = http.createServer(app);

// Pings más relajados: mantienen viva la conexión a través de proxies y redes móviles
const io = new Server(server, { pingInterval: 20_000, pingTimeout: 30_000 });

// ---------- Archivos estáticos ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
// Verificación al arrancar: avisa en la terminal si falta algún archivo
const REQUIRED_FILES = [
  'index.html',
  'admin.html',
  'css/styles.css',
  'js/player.js',
  'js/admin.js',
];
const missing = REQUIRED_FILES.filter(f => !fs.existsSync(path.join(PUBLIC_DIR, f)));
if (missing.length) {
  console.error('\n⚠️  Faltan archivos en public/:');
  missing.forEach(f => console.error(`   - public/${f}`));
  console.error('   Revisá la estructura de carpetas (ver README).\n');
}
// Sirve todo lo que esté dentro de public/ (css, js, imágenes)
app.use(express.static(PUBLIC_DIR, { index: false }));
// Vistas
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/healthz', (req, res) => res.send('ok'));
// Si un asset no existe, responder texto plano con la ruta exacta (así el error es claro)
app.use('/js', (req, res) =>
  res.status(404).type('text/plain').send(`No existe public/js${req.path}`));
app.use('/css', (req, res) =>
  res.status(404).type('text/plain').send(`No existe public/css${req.path}`));

// ---------- Estado (en memoria) ----------
const game = {
  phase: 'lobby',            // 'lobby' | 'playing'
  round: 0,
  roundLocked: false,
  buzzed: false,
  players: new Map(),        // playerId -> { id, name, score, status, socketId, online }
  kicked: new Set(),         // playerId sacados por el admin en esta sesión
  queue: [],                 // [{ id: playerId, name, ts }]
};

function snapshot() {
  return {
    phase: game.phase,
    round: game.round,
    roundLocked: game.roundLocked,
    players: [...game.players.values()].map(({ id, name, score, status, online }) => ({
      id, name, score, status, online,
    })),
    queue: game.queue.map(q => ({ id: q.id, name: q.name, ts: q.ts })),
  };
}

function broadcast() {
  io.emit('state', snapshot());
}

function resetRound() {
  game.roundLocked = false;
  game.buzzed = false;
  game.queue = [];
  for (const p of game.players.values()) p.status = 'active';
}

// ---------- Conexiones ----------
io.on('connection', (socket) => {
  socket.data.playerId = null;
  socket.data.isAdmin = false;
  socket.emit('state', snapshot());

  // Jugador: "Listo" (o reconexión automática)
  socket.on('player:join', (payload, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const playerId = String(payload?.playerId || '').slice(0, 64);
    const name = String(payload?.name || '').trim().slice(0, 20);

    if (!playerId) return reply({ ok: false, error: 'Sesión inválida. Recargá la página.' });
    if (game.kicked.has(playerId)) {
      return reply({ ok: false, kicked: true, error: 'El anfitrión te sacó de la sala.' });
    }

    let p = game.players.get(playerId);
    if (p) {
      // Reconexión: conservamos nombre y puntaje, solo actualizamos el socket
      p.socketId = socket.id;
      p.online = true;
    } else {
      if (!name) return reply({ ok: false, error: 'Escribí tu nombre.' });
      if (game.phase !== 'lobby') {
        return reply({ ok: false, error: 'La partida ya empezó. Esperá la próxima.' });
      }
      p = { id: playerId, name, score: 0, status: 'active', socketId: socket.id, online: true };
      game.players.set(playerId, p);
    }

    socket.data.playerId = playerId;
    reply({ ok: true, playerId, name: p.name });
    broadcast();
  });

  // Jugador: toca la pantalla
  socket.on('player:press', () => {
    const pid = socket.data.playerId;
    const p = game.players.get(pid);
    if (!p || game.phase !== 'playing' || game.roundLocked) return;
    if (p.status !== 'active') return;
    if (game.queue.some(q => q.id === pid)) return;

    game.queue.push({ id: pid, name: p.name, ts: Date.now() });
    game.queue.sort((a, b) => a.ts - b.ts);

    if (!game.buzzed) {
      game.buzzed = true;
      io.to('admins').emit('buzz');
    }
    broadcast();
  });

  // Admin: PIN
  socket.on('admin:auth', (pin, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (String(pin) !== ADMIN_PIN) return reply({ ok: false });
    socket.data.isAdmin = true;
    socket.join('admins');
    reply({ ok: true });
    socket.emit('state', snapshot());
  });

  const onAdmin = (event, handler) => {
    socket.on(event, (payload) => {
      if (!socket.data.isAdmin) return;
      handler(payload);
    });
  };

  onAdmin('admin:start', () => {
    if (game.phase !== 'lobby' || game.players.size === 0) return;
    game.phase = 'playing';
    game.round = 1;
    resetRound();
    broadcast();
  });

  onAdmin('admin:next', () => {
    if (game.phase !== 'playing') return;
    game.round += 1;
    resetRound();
    broadcast();
  });

  onAdmin('admin:endgame', () => {
    game.phase = 'lobby';
    game.round = 0;
    resetRound();
    broadcast();
  });

  onAdmin('admin:correct', () => {
    const head = game.queue[0];
    if (!head || game.roundLocked) return;
    const p = game.players.get(head.id);
    if (p) p.score += 1;
    game.roundLocked = true;
    game.queue = [];
    broadcast();
  });

  onAdmin('admin:wrong', () => {
    const head = game.queue.shift();
    if (!head) return;
    const p = game.players.get(head.id);
    if (p) {
      p.score -= 1;
      p.status = 'eliminated';
    }
    broadcast();
  });

  onAdmin('admin:score', ({ id, delta }) => {
    const p = game.players.get(id);
    const d = parseInt(delta, 10);
    if (!p || Number.isNaN(d)) return;
    p.score += d;
    broadcast();
  });

  onAdmin('admin:kick', (id) => {
    const p = game.players.get(id);
    if (!p) return;
    game.players.delete(id);
    game.kicked.add(id);
    game.queue = game.queue.filter(q => q.id !== id);
    if (p.socketId) io.to(p.socketId).emit('kicked');
    broadcast();
  });

  // Desconexión: NO borramos al jugador, solo lo marcamos offline
  socket.on('disconnect', () => {
    const pid = socket.data.playerId;
    const p = pid && game.players.get(pid);
    if (!p || p.socketId !== socket.id) return; // ya reconectó con otro socket

    p.online = false;
    p.socketId = null;
    broadcast();

    if (game.phase === 'lobby') {
      setTimeout(() => {
        const cur = game.players.get(pid);
        if (cur && !cur.online) {
          game.players.delete(pid);
          broadcast();
        }
      }, OFFLINE_GRACE_MS);
    }
  });
});

// ---------- IPs de la red local ----------
function getLanIps() {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      const isV4 = i.family === 'IPv4' || i.family === 4;
      if (isV4 && !i.internal) ips.push(i.address);
    }
  }
  return ips;
}

server.listen(PORT, HOST, () => {
  if (IS_HOSTED) {
    console.log(`\n🎵 En una nota online · puerto ${PORT}`);
    console.log(`   URL pública: ${process.env.RENDER_EXTERNAL_URL || '(mirá la URL en tu panel de hosting)'}\n`);
    return;
  }

  const ips = getLanIps();
  console.log('\n🎵 En una nota está corriendo\n');
  console.log(`   Local:      http://localhost:${PORT}`);
  if (ips.length === 0) {
    console.log('   (No se detectó IP de red local)');
  } else {
    ips.forEach(ip => {
      console.log(`   Jugadores:  http://${ip}:${PORT}`);
      console.log(`   Anfitrión:  http://${ip}:${PORT}/admin`);
    });
  }
  console.log('\n   PIN admin: definido con ADMIN_PIN (por defecto 1234)\n');
});

