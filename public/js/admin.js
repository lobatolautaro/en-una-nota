const socket = io();
const $ = (id) => document.getElementById(id);

let songsCache = [];

socket.on('songs', (list) => {
  songsCache = list;
  if (state) render();
});

let songSort = 'orden';
socket.on('songs', (list) => {
  songsCache = list;
  if (state) render();   // por si el catálogo llega después del primer state
});
$('songs-sort').addEventListener('change', (e) => {
  songSort = e.target.value;
  renderSongsList();
});


const SOUND_ENABLED = false;

let state = null;
let authed = false;
let savedPin = null;
let audioCtx = null;
let clockOffset = 0;

const lastHtml = {};
function setHtml(id, html) {
  if (lastHtml[id] === html) return;   // no tocar el DOM si no cambió
  lastHtml[id] = html;
  $(id).innerHTML = html;
}


// ---------- Audio y vibración ----------
function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) {}
}

function softBeep() {
  if (!SOUND_ENABLED || !audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 660;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.08, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 0.3);
}

function onFirstBuzz() {
  softBeep();
  if (navigator.vibrate) navigator.vibrate(80);
}

// ---------- PIN ----------
function login() {
  unlockAudio();
  const value = $('pin').value.trim();
  socket.emit('admin:auth', value, (res) => {
    if (!res.ok) {
      $('pin-error').textContent = 'PIN incorrecto';
      return;
    }
    authed = true;
    savedPin = value;
    $('pin-error').textContent = '';
    $('pin-screen').classList.add('hidden');
    $('panel').classList.remove('hidden');
  });
}

$('pin-btn').addEventListener('click', login);
$('pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });

socket.on('connect', () => {
  if (authed) socket.emit('admin:auth', savedPin, () => {});
});

// ---------- Eventos del servidor ----------
socket.on('state', (s) => {
  state = s;
  clockOffset = s.serverNow - Date.now();
  render();
});

socket.on('buzz', onFirstBuzz);

// ---------- Acciones ----------
$('start-btn').addEventListener('click', () => {
  unlockAudio();
  socket.emit('admin:start');
});

$('start-round-btn').addEventListener('click', () => {
  unlockAudio();
  socket.emit('admin:startRound');
});

$('lobby-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-kick]');
  if (btn && confirm('¿Sacar a este jugador?')) {
    socket.emit('admin:kick', btn.dataset.kick);
  }
});

$('correct-btn').addEventListener('click', () => socket.emit('admin:correct'));
$('wrong-btn').addEventListener('click', () => socket.emit('admin:wrong'));

// Mismo botón: "Siguiente" o "Terminar juego" según la canción
$('next-btn').addEventListener('click', () => {
  if (!state) return;
  if (state.canFinish) {
    if (confirm('¿Terminar el juego y mostrar la tabla final?')) socket.emit('admin:finish');
  } else {
    socket.emit('admin:next');
  }
});

$('endgame-btn').addEventListener('click', () => {
  if (confirm('¿Volver al lobby? Los puntajes se mantienen.')) socket.emit('admin:endgame');
});

$('newgame-btn').addEventListener('click', () => {
  if (confirm('¿Nueva partida? Los puntajes se reinician a 0.')) socket.emit('admin:newGame');
});

$('final-lobby-btn').addEventListener('click', () => {
  if (confirm('¿Volver al lobby? Los puntajes se mantienen.')) socket.emit('admin:endgame');
});

$('songs-ol').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-song]');
  if (btn && !btn.disabled) socket.emit('admin:setSong', Number(btn.dataset.song));
});

$('score-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-delta]');
  if (!btn) return;
  socket.emit('admin:score', { id: btn.dataset.id, delta: Number(btn.dataset.delta) });
});

$('force-finish-btn').addEventListener('click', () => {
  if (confirm('¿Terminar la partida ahora? Todos verán la tabla final.')) {
    socket.emit('admin:finish');
  }
});


// ---------- Cronómetro de ronda ----------
function updateClock() {
  const el = $('round-clock');
  if (!state || !state.roundStarted) {
    el.textContent = 'sin iniciar';
    return;
  }
  const ms = Date.now() + clockOffset - state.roundStartedAt;
  el.textContent = (Math.max(0, ms) / 1000).toFixed(1) + 's';
}
setInterval(updateClock, 100);

// ---------- Render ----------
function render() {
  if (!authed || !state) return;
  const phase = state.phase;
  $('lobby-view').classList.toggle('hidden', phase !== 'lobby');
  $('game-view').classList.toggle('hidden', phase !== 'playing');
  $('final-view').classList.toggle('hidden', phase !== 'finished');

  if (phase === 'lobby') renderLobby();
  else if (phase === 'playing') renderGame();
  else renderFinal();
}

function renderLobby() {
  $('lobby-count').textContent = state.players.length;
  $('songs-count').textContent = state.songCount
    ? `Canciones cargadas: ${state.songCount}`
    : '⚠️ No hay canciones: revisá data/canciones.json';

  setHtml('lobby-list', state.players.length
    ? state.players.map(p => `
        <li class="player-row">
          <span>${esc(p.name)} ${p.online ? '' : '<small class="muted">(desconectado)</small>'}</span>
          <button class="btn-x" data-kick="${p.id}" aria-label="Sacar jugador">✕</button>
        </li>`).join('')
    : '<li class="muted">Esperando que se sumen jugadores...</li>');

  $('start-btn').disabled = state.players.length === 0;
}

function renderGame() {
  $('round-label').textContent = `Ronda ${state.round}`;
  $('start-round-btn').classList.toggle('hidden', state.roundStarted);

  renderSong();
  renderQueue();
  renderWinner();
  renderEliminated();
  renderNext();
  renderSongsList();
  renderScores();
}

function renderFinal() {
  const list = state.standings || [];
  const leaders = list.filter(s => s.rank === 1);

  $('final-headline').textContent = !list.length
    ? 'Sin jugadores'
    : leaders.length === 1
      ? `Ganador: ${leaders[0].name}`
      : 'Empate en el primer puesto';

  setHtml('final-list', list.length
    ? list.map(s => `
        <li class="final-row">
          <span class="fpos">${medal(s.rank)}</span>
          <span class="fname">${esc(s.name)}</span>
          <span class="fpts">${s.score} pts</span>
        </li>`).join('')
    : '<li class="muted">Sin jugadores</li>');
}

function medal(rank) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `${rank}°`;
}

function renderSong() {
  const card = $('song-card');
  const s = state.currentSong;

  if (!state.songCount || !s) {
    setHtml('song-card', '<p class="muted song-empty">Sin canciones: cargá data/canciones.json</p>');
    return;
  }

  const thumb = s.tapa
    ? `<img class="song-thumb" src="${escAttr(s.tapa)}" alt="Tapa" onerror="this.remove()">`
    : '<div class="song-thumb placeholder">🎵</div>';

  setHtml('song-card', `
    ${thumb}
    <div class="song-text">
      <small class="muted">Canción ${state.songIndex + 1} de ${state.songCount}</small>
      <strong>${esc(s.titulo)}</strong>
      <span>${esc(s.artista)}</span>
    </div>`);
}

function renderQueue() {
  const q = state.queue;
  const first = q[0];

  let status = '';
  if (!state.roundStarted) status = 'Ronda sin iniciar. Presioná "Iniciar ronda" cuando empiece la música.';
  else if (state.roundLocked) status = 'Ronda cerrada.';
  else if (q.length === 0) status = 'Ronda en curso. Nadie tocó todavía.';

  if (state.canFinish) {
    status = 'Se jugaron todas las canciones. Presioná "Terminar juego" cuando quieras.';
  }
  $('round-status').textContent = status;

  $('alert').classList.toggle('hidden', q.length === 0);

  setHtml('queue', q.map((e, i) => `
    <li class="${i === 0 ? 'first' : ''}">
      ${i + 1}° ${esc(e.name)}
      <span class="qtime">${(e.elapsed / 1000).toFixed(2)}s</span>
    </li>`).join(''));

  $('answer-box').classList.toggle('hidden', q.length === 0);
  if (first) $('first-name').textContent = first.name;
}

function renderWinner() {
  const box = $('winner-banner');
  const w = state.winner;

  if (!(state.roundLocked && w)) {
    box.classList.add('hidden');
    setHtml('winner-banner', '');
    return;
  }

  const song = w.song
    ? `<span class="wsong">🎵 ${esc(w.song.titulo)} · ${esc(w.song.artista)}</span>`
    : '';
  setHtml('winner-banner', `🏆 Ganó ${esc(w.name)}${song}`);
  box.classList.remove('hidden');
}

function renderEliminated() {
  const list = state.eliminated || [];
  setHtml('elim-box', list.length
    ? `<strong>❌ Eliminados en esta ronda:</strong><br>${list.map(e => `<span class="chip">${esc(e.name)}</span>`).join('')}`
    : '<span class="muted">Nadie eliminado en esta ronda.</span>');
}

// Botón inferior: "Siguiente" o "Terminar juego" en la última canción
function renderNext() {
  const btn = $('next-btn');

  if (state.canFinish) {
    btn.disabled = false;
    btn.textContent = '🏁 Terminar juego';
    btn.classList.add('btn-finish');
    btn.classList.remove('btn-primary');
    return;
  }

  const blocked = !state.roundStarted;
  btn.disabled = blocked;
  btn.textContent = blocked
    ? 'Iniciá la ronda para avanzar'
    : `Siguiente Canción / Nueva Ronda (quedan ${state.availableCount})`;
  btn.classList.remove('btn-finish');
  btn.classList.add('btn-primary');
}


function renderSongsList() {
  const songs = songsCache;
  const played = new Set(state.played || []);

  $('songs-summary').textContent = `🎵 Canciones (${played.size}/${songs.length} jugadas)`;

  const order = songs.map((s, i) => ({ s, i }));
  if (songSort === 'titulo') {
    order.sort((a, b) => a.s.titulo.localeCompare(b.s.titulo, 'es'));
  } else if (songSort === 'artista') {
    order.sort((a, b) =>
      a.s.artista.localeCompare(b.s.artista, 'es') || a.s.titulo.localeCompare(b.s.titulo, 'es'));
  }

  const html = order.map(({ s, i }) => {
    const isPlayed = played.has(i);
    const isCurrent = i === state.songIndex;
    const cls = [isCurrent ? 'current' : '', isPlayed ? 'played' : ''].join(' ').trim();
    const disabled = isPlayed || state.roundStarted;
    const label = isPlayed ? 'Jugada' : isCurrent ? 'Elegida' : 'Elegir';
    return `
      <li class="${cls}">
        <span>${i + 1}. ${esc(s.titulo)} — ${esc(s.artista)}</span>
        <button class="btn btn-small" data-song="${i}" ${disabled ? 'disabled' : ''}>${label}</button>
      </li>`;
  }).join('');

  setHtml('songs-ol', html || '<li class="muted">Sin canciones</li>');
}


function renderScores() {
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  setHtml('score-list', sorted.length
    ? sorted.map(p => `
        <li class="score-row">
          <span class="sname">${esc(p.name)}</span>
          <span class="spts">${p.score}</span>
          <button class="btn-adj" data-id="${p.id}" data-delta="-1">−</button>
          <button class="btn-adj" data-id="${p.id}" data-delta="1">+</button>
        </li>`).join('')
    : '<li class="muted">Sin jugadores</li>');
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function escAttr(str) {
  return esc(str).replace(/"/g, '&quot;');
}



