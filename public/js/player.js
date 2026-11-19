const socket = io();
const $ = (id) => document.getElementById(id);

const STORAGE_KEY = 'en-una-nota:jugador';
const PAD = $('pad');
const PAD_TEXT = $('pad-text');

let state = null;
let me = loadSaved();   // { playerId, name }
let joinTimer = null;

// crypto.randomUUID solo existe en contextos seguros (https o localhost).
// En http://192.168.x.x no está disponible, por eso hay un fallback.
function makeId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

function loadSaved() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (data && data.playerId) return data;
  } catch (e) { /* storage no disponible o corrupto */ }
  return { playerId: makeId(), name: '' };
}

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(me)); } catch (e) {}
}

function forgetMe(msg) {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  me = { playerId: makeId(), name: '' };
  $('name').value = '';
  setJoinError(msg || 'El anfitrión te sacó de la sala.');
}

function setJoinError(msg) {
  $('join-error').textContent = msg || '';
}

// ---------- Lobby: "Listo" y reconexión ----------
function join(nameFromInput) {
  const typed = (nameFromInput ?? $('name').value).trim();
  const name = typed || me.name;

  if (!name) return setJoinError('Escribí tu nombre para jugar.');

  $('ready-btn').disabled = true;

  // Si el servidor no responde en 5 s, liberamos el botón
  clearTimeout(joinTimer);
  joinTimer = setTimeout(() => {
    $('ready-btn').disabled = false;
    setJoinError('Sin respuesta del servidor. Revisá la conexión y probá de nuevo.');
  }, 5000);

  socket.emit('player:join', { playerId: me.playerId, name }, (res) => {
    clearTimeout(joinTimer);
    $('ready-btn').disabled = false;

    if (!res || !res.ok) {
      if (res && res.kicked) return forgetMe(res.error);
      return setJoinError(res?.error || 'No se pudo entrar.');
    }

    me = { playerId: res.playerId, name: res.name };
    persist();
    setJoinError('');
  });
}

$('ready-btn').addEventListener('click', () => join());
$('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

// Cada vez que se (re)conecta, si ya tenemos nombre, reanunciamos al jugador
socket.on('connect', () => {
  if (me.name) join(me.name);
});

// ---------- Pulsador ----------
PAD.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!state) return;
  const mine = findMe();
  if (!mine || mine.status !== 'active' || state.roundLocked) return;
  if (state.queue.some(q => q.id === me.playerId)) return;
  socket.emit('player:press');
});

// ---------- Estado ----------
socket.on('state', (s) => {
  state = s;
  render();
});

socket.on('kicked', () => forgetMe());

function findMe() {
  return state.players.find(p => p.id === me.playerId);
}

function showScreen(name) {
  $('lobby').classList.toggle('hidden', name !== 'lobby');
  $('game').classList.toggle('hidden', name !== 'game');
}

function render() {
  const mine = findMe();

  $('player-list').innerHTML = state.players.length
    ? state.players.map(p => `
        <li>
          ${p.id === me.playerId ? '⭐ ' : ''}${esc(p.name)}
          ${p.online ? '' : ' <small class="muted">(desconectado)</small>'}
        </li>`).join('')
    : '<li class="muted">Todavía nadie</li>';

  // Todavía no estoy en la partida: mostrar formulario
  if (!mine) {
    showScreen('lobby');
    $('join-form').classList.remove('hidden');
    $('waiting').classList.add('hidden');
    if (!$('name').value && me.name) $('name').value = me.name;
    return;
  }

  // Estoy en la partida, fase lobby: esperando
  if (state.phase === 'lobby') {
    showScreen('lobby');
    $('join-form').classList.add('hidden');
    $('waiting').classList.remove('hidden');
    return;
  }

  // Partida en curso: pantalla de juego
  showScreen('game');
  $('my-score').textContent = mine.score;

  const pos = state.queue.findIndex(q => q.id === me.playerId);
  let cls, text;

  if (mine.status === 'eliminated') {
    cls = 'state-eliminated';
    text = 'Eliminado de esta ronda. Esperá la siguiente canción';
  } else if (pos >= 0) {
    cls = 'state-queued';
    text = `¡Apretaste! Estás ${pos + 1}° en la cola`;
  } else if (state.roundLocked) {
    cls = 'state-locked';
    text = 'Ya hay ganador de esta canción. Esperá la siguiente';
  } else {
    cls = 'state-active';
    text = '¡TOCÁ!';
  }

  PAD.className = `pad ${cls}`;
  PAD_TEXT.textContent = text;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
