const socket = io();
const $ = (id) => document.getElementById(id);

let state = null;
let authed = false;
let savedPin = null;
let audioCtx = null;

// ---------- Audio (Web Audio API) y vibración ----------
function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { /* sin audio disponible */ }
}

function buzzer() {
  if (audioCtx) {
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.linearRampToValueAtTime(170, t + 1);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
    gain.gain.setValueAtTime(0.5, t + 0.9);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 1.05);
  }
  if (navigator.vibrate) navigator.vibrate([400, 150, 400]);
}

// ---------- PIN ----------
function login() {
  unlockAudio(); // el navegador exige un gesto del usuario para habilitar audio
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

// Si se cae la conexión, reautenticar automáticamente
socket.on('connect', () => {
  if (authed) socket.emit('admin:auth', savedPin, () => {});
});

// ---------- Eventos del servidor ----------
socket.on('state', (s) => {
  state = s;
  render();
});

socket.on('buzz', buzzer);

// ---------- Acciones ----------
$('start-btn').addEventListener('click', () => {
  unlockAudio();
  socket.emit('admin:start');
});

$('lobby-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-kick]');
  if (btn && confirm('¿Sacar a este jugador?')) {
    socket.emit('admin:kick', btn.dataset.kick);
  }
});

$('correct-btn').addEventListener('click', () => socket.emit('admin:correct'));
$('wrong-btn').addEventListener('click', () => socket.emit('admin:wrong'));
$('next-btn').addEventListener('click', () => socket.emit('admin:next'));

$('endgame-btn').addEventListener('click', () => {
  if (confirm('¿Terminar la partida y volver al lobby?')) socket.emit('admin:endgame');
});

$('score-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-delta]');
  if (!btn) return;
  socket.emit('admin:score', { id: btn.dataset.id, delta: Number(btn.dataset.delta) });
});

// ---------- Render ----------
function render() {
  if (!authed || !state) return;
  const lobby = state.phase === 'lobby';
  $('lobby-view').classList.toggle('hidden', !lobby);
  $('game-view').classList.toggle('hidden', lobby);
  if (lobby) renderLobby();
  else renderGame();
}

function renderLobby() {
  $('lobby-count').textContent = state.players.length;
  $('lobby-list').innerHTML = state.players.length
    ? state.players.map(p => `
        <li class="player-row">
          <span>${esc(p.name)} ${p.online ? '' : '<small class="muted">(desconectado)</small>'}</span>
          <button class="btn-x" data-kick="${p.id}" aria-label="Sacar jugador">✕</button>
        </li>`).join('')
    : '<li class="muted">Esperando que se sumen jugadores...</li>';
  $('start-btn').disabled = state.players.length === 0;
}


function renderGame() {
  $('round-label').textContent = `Ronda ${state.round}`;

  const q = state.queue;
  const first = q[0];

  $('alert').classList.toggle('hidden', q.length === 0);

  $('queue').innerHTML = q.map((e, i) => {
    const t = i === 0 ? '0.00s' : `+${((e.ts - first.ts) / 1000).toFixed(2)}s`;
    return `<li class="${i === 0 ? 'first' : ''}">${i + 1}° ${esc(e.name)} (${t})</li>`;
  }).join('');

  $('queue-empty').textContent = q.length
    ? ''
    : (state.roundLocked
        ? 'Ronda cerrada: hubo acierto. Pasá a la siguiente canción.'
        : 'Nadie tocó todavía.');

  $('answer-box').classList.toggle('hidden', q.length === 0);
  if (first) $('first-name').textContent = first.name;

  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  $('score-list').innerHTML = sorted.length
    ? sorted.map(p => `
        <li class="score-row">
          <span class="sname">${esc(p.name)}</span>
          <span class="spts">${p.score}</span>
          <button class="btn-adj" data-id="${p.id}" data-delta="-1">−</button>
          <button class="btn-adj" data-id="${p.id}" data-delta="1">+</button>
        </li>`).join('')
    : '<li class="muted">Sin jugadores</li>';
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
