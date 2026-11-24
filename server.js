const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const IS_HOSTED = Boolean(process.env.RENDER || process.env.RAILWAY_ENVIRONMENT);
const OFFLINE_GRACE_MS = 60_000;

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 20_000, pingTimeout: 30_000 });

// ---------- Archivos estáticos ----------
const PUBLIC_DIR = path.join(__dirname, 'public');

const REQUIRED_FILES = ['index.html', 'admin.html', 'css/styles.css', 'js/player.js', 'js/admin.js'];
const missing = REQUIRED_FILES.filter(f => !fs.existsSync(path.join(PUBLIC_DIR, f)));
if (missing.length) {
  console.error('\n⚠️  Faltan archivos en public/:');
  missing.forEach(f => console.error(`   - public/${f}`));
  console.error('');
}

app.use(express.static(PUBLIC_DIR, {
  index: false,
  setHeaders(res, filePath) {
    // Evita que un navegador siga usando un player.js o admin.js viejo
    if (/\.(html|js|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));  
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/healthz', (req, res) => res.send('ok'));
app.use('/js', (req, res) => res.status(404).type('text/plain').send(`No existe public/js${req.path}`));
app.use('/css', (req, res) => res.status(404).type('text/plain').send(`No existe public/css${req.path}`));

// ---------- Listado de canciones ----------
const SONGS_FILE = path.join(__dirname, 'data', 'canciones.json');

function isHttpUrl(v) {
  return typeof v === 'string' && /^https?:\/\//i.test(v.trim());
}

function loadSongs() {
  try {
    const raw = JSON.parse(fs.readFileSync(SONGS_FILE, 'utf8'));
    if (!Array.isArray(raw)) throw new Error('el archivo debe contener un array []');
    const songs = raw
      .filter(s => s && typeof s.titulo === 'string' && typeof s.artista === 'string')
      .map(s => ({
        titulo: s.titulo.trim().slice(0, 80),
        artista: s.artista.trim().slice(0, 60),
        tapa: isHttpUrl(s.tapa) ? s.tapa.trim() : '',
      }))
      .filter(s => s.titulo && s.artista);
    console.log(`🎵 ${songs.length} canciones cargadas desde data/canciones.json`);
    return songs;
  } catch (err) {
    console.error(`⚠️  No se pudo cargar data/canciones.json: ${err.message}`);
    return [];
  }
}

const SONGS = loadSongs();

// ---------- Estado (en memoria) ----------
const game = {
  phase: 'lobby',            // 'lobby' | 'playing' | 'finished'
  round: 0,
  songIndex: null,           // canción elegida para la ronda actual (null si no quedan)
  played: new Set(),         // índices de canciones ya jugadas en esta partida
  roundStarted: false,
  roundStartedAt: null,
  roundLocked: false,
  buzzed: false,
  winner: null,              // { id, name, round, song }
  eliminated: [],            // [{ id, name }]
  players: new Map(),        // playerId -> { id, name, score, status, socketId, online, offlineTimer }
  kicked: new Set(),
  queue: [],                 // [{ id, name, ts }]
};

function availableCount() {
  return SONGS.length - game.played.size;
}

function firstAvailableIndex() {
  for (let i = 0; i < SONGS.length; i++) {
    if (!game.played.has(i)) return i;
  }
  return null;
}

// Se puede terminar solo cuando ya no queda ninguna canción sin jugar
function canFinish() {
  return game.phase === 'playing' && availableCount() === 0;
}

function currentSong() {
  if (game.songIndex === null) return null;
  const s = SONGS[game.songIndex];
  return s ? { titulo: s.titulo, artista: s.artista, tapa: s.tapa } : null;
}

// Ranking competitivo: empates comparten puesto (1, 1, 3...)
function getStandings() {
  const sorted = [...game.players.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'es'));
  let rank = 0;
  let prevScore = null;
  return sorted.map((p, i) => {
    if (prevScore === null || p.score !== prevScore) rank = i + 1;
    prevScore = p.score;
    return { id: p.id, name: p.name, score: p.score, rank, online: p.online };
  });
}

// Datos que ven todos (jugadores y admin). Sin catálogo.
function baseSnapshot() {
  const startedAt = game.roundStartedAt;
  return {
    serverNow: Date.now(),
    phase: game.phase,
    round: game.round,
    roundStarted: game.roundStarted,
    roundStartedAt: startedAt,
    roundLocked: game.roundLocked,
    winner: game.winner,
    eliminated: game.eliminated,
    songCount: SONGS.length,
    standings: getStandings(),
    players: [...game.players.values()].map(({ id, name, score, status, online }) => ({
      id, name, score, status, online,
    })),
    queue: game.queue.map(q => ({
      id: q.id,
      name: q.name,
      ts: q.ts,
      elapsed: startedAt ? q.ts - startedAt : 0,
    })),
  };
}

// Jugadores: sin catálogo ni canción actual
function publicSnapshot() {
  return baseSnapshot();
}

// Admin: estado de selección. El catálogo NO va acá, se envía una sola vez por "songs".
function adminSnapshot() {
  return {
    ...baseSnapshot(),
    songIndex: game.songIndex,
    currentSong: currentSong(),
    played: [...game.played],          // solo índices (números), liviano
    availableCount: availableCount(),
    canFinish: canFinish(),
  };
}

function broadcast() {
  io.to('admins').emit('state', adminSnapshot());
  io.except('admins').emit('state', publicSnapshot());
}

// Limpia solo lo de la ronda (no toca canciones jugadas ni puntajes)
function resetRound() {
  game.roundStarted = false;
  game.roundStartedAt = null;
  game.roundLocked = false;
  game.buzzed = false;
  game.winner = null;
  game.queue = [];
  game.eliminated = [];
  for (const p of game.players.values()) p.status = 'active';
}

// Vuelve al lobby: limpia canciones jugadas para la próxima partida
function backToLobby() {
  game.phase = 'lobby';
  game.round = 0;
  game.played.clear();
  game.songIndex = null;
  resetRound();
}

// ---------- Conexiones ----------
io.on('connection', (socket) => {
  socket.data.playerId = null;
  socket.data.isAdmin = false;
  socket.emit('state', publicSnapshot());

  // Jugador: "Listo" o reconexión
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
      clearTimeout(p.offlineTimer);   // NUEVO: cancela la baja pendiente
      p.offlineTimer = null;
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

  // Jugador: toca su pantalla
  socket.on('player:press', () => {
    const pid = socket.data.playerId;
    const p = game.players.get(pid);
    if (!p || game.phase !== 'playing' || game.roundLocked) return;
    if (!game.roundStarted) return;
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
  socket.data.pinTries = 0;
  socket.on('admin:auth', (pin, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (socket.data.pinTries >= 5) {
      return reply({ ok: false, error: 'Demasiados intentos. Recargá la página.' });
    }
    if (String(pin) !== ADMIN_PIN) {
      socket.data.pinTries += 1;
      return reply({ ok: false });
    }
    socket.data.isAdmin = true;
    socket.join('admins');
    reply({ ok: true });
    socket.emit('songs', SONGS);
    socket.emit('state', adminSnapshot());
  });

    const onAdmin = (event, handler) => {
    socket.on(event, (payload) => {
      if (!socket.data.isAdmin) return;
      handler(payload);
    });
  };

  onAdmin('admin:start', () => {
    if (game.phase !== 'lobby' || game.players.size === 0) return;
    if (SONGS.length === 0) return;
    game.phase = 'playing';
    game.round = 1;
    game.played.clear();
    game.songIndex = firstAvailableIndex();
    resetRound();
    broadcast();
  });

  // Iniciar ronda: la canción queda "jugada" y sale de las disponibles
  onAdmin('admin:startRound', () => {
    if (game.phase !== 'playing' || game.roundStarted) return;
    if (game.songIndex === null) return;
    game.played.add(game.songIndex);
    game.roundStarted = true;
    game.roundStartedAt = Date.now();
    broadcast();
  });

  // Elegir libremente cualquier canción no jugada (solo antes de iniciar la ronda)
  onAdmin('admin:setSong', (index) => {
    const i = Number(index);
    if (game.phase !== 'playing' || game.roundStarted) return;
    if (!Number.isInteger(i) || i < 0 || i >= SONGS.length) return;
    if (game.played.has(i)) return;
    game.songIndex = i;
    broadcast();
  });

  // Siguiente ronda: preselecciona la primera canción que queda sin jugar
  onAdmin('admin:next', () => {
    if (game.phase !== 'playing') return;
    if (!game.roundStarted) return;          // hay que iniciar la ronda antes de avanzar
    if (availableCount() === 0) return;      // sin canciones: corresponde "Terminar"
    game.round += 1;
    resetRound();
    game.songIndex = firstAvailableIndex();
    broadcast();
  });


// Terminar la partida: desde el botón principal (canFinish) o el botón chico (cualquier momento)
  onAdmin('admin:finish', () => {
    if (game.phase !== 'playing') return;
    game.phase = 'finished';
    game.queue = [];
    broadcast();
  });


  onAdmin('admin:newGame', () => {
    backToLobby();
    for (const p of game.players.values()) p.score = 0;
    broadcast();
  });

  onAdmin('admin:endgame', () => {
    backToLobby();
    broadcast();
  });


  onAdmin('admin:correct', () => {
    const head = game.queue[0];
    if (!head || game.roundLocked) return;
    const p = game.players.get(head.id);
    if (p) p.score += 1;
    game.roundLocked = true;
    game.winner = { id: head.id, name: head.name, round: game.round, song: currentSong() };
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
    if (!game.eliminated.some(e => e.id === head.id)) {
      game.eliminated.push({ id: head.id, name: head.name });
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
    game.eliminated = game.eliminated.filter(e => e.id !== id);
    if (p.socketId) io.to(p.socketId).emit('kicked');
    broadcast();
  });

  socket.on('disconnect', () => {
    const pid = socket.data.playerId;
    const p = pid && game.players.get(pid);
    if (!p || p.socketId !== socket.id) return;

    p.online = false;
    p.socketId = null;
    broadcast();

    if (game.phase === 'lobby') {
      clearTimeout(p.offlineTimer);   // evita timers duplicados
      p.offlineTimer = setTimeout(() => {
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


