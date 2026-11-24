const socket = io();
const $ = (id) => document.getElementById(id);

const STORAGE_KEY = 'en-una-nota:jugador';
const PAD = $('pad');
const PAD_TEXT = $('pad-text');
const EXTRA = $('pad-extra');
const COVER = $('song-cover');

let state = null;
let me = loadSaved();
let joinTimer = null;
let lastList = ''; 

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
  } catch (e) {}
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

// ---------- Lobby ----------
function join(nameFromInput) {
  const typed = (nameFromInput ?? $('name').value).trim();
  const name = typed || me.name;

  if (!name) return setJoinError('Escribí tu nombre para jugar.');

  $('ready-btn').disabled = true;

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

socket.on('connect', () => {
  if (me.name) join(me.name);
});

// ---------- Pulsador ----------
PAD.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!state || !state.roundStarted) return;
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

const SCREENS = ['lobby', 'game', 'final'];

function showScreen(name) {
  for (const s of SCREENS) {
    const el = $(s);
    if (el) el.classList.toggle('hidden', s !== name);
  }
}

// Muestra tapa, canción y artista solo cuando hay ganador
function showWinnerInfo(w) {
  if (!w) {
    EXTRA.classList.add('hidden');
    return;
  }
  EXTRA.classList.remove('hidden');

  const s = w.song;
  $('song-title').textContent = s ? s.titulo : '';
  $('song-artist').textContent = s ? s.artista : '';
  $('pad-hint').textContent = 'Esperá la siguiente canción';

    if (s && s.tapa) {
    COVER.onerror = () => COVER.classList.add('hidden');
    if (COVER.getAttribute('src') !== s.tapa) COVER.src = s.tapa;   // evita recargas
    COVER.classList.remove('hidden');
  } else {
    COVER.removeAttribute('src');
    COVER.classList.add('hidden');
  }
}

function render() {
    // La fase final tiene prioridad sobre todo lo demás
  if (state.phase === 'finished') {
    showScreen('final');
    renderFinal();
    return;
  }
  const mine = findMe();

  let lastList = '';
  const listHtml = state.players.length
    ? state.players.map(p => `<li>${p.id === me.playerId ? '⭐ ' : ''}${esc(p.name)}${p.online ? '' : ' <small class="muted">(desconectado)</small>'}</li>`).join('')
    : '<li class="muted">Todavía nadie</li>';
  if (listHtml !== lastList) {
    $('player-list').innerHTML = listHtml;
    lastList = listHtml;
  }

  if (!mine) {
    showScreen('lobby');
    $('join-form').classList.remove('hidden');
    $('waiting').classList.add('hidden');
    if (!$('name').value && me.name) $('name').value = me.name;
    return;
  }

  if (state.phase === 'lobby') {
    showScreen('lobby');
    $('join-form').classList.add('hidden');
    $('waiting').classList.remove('hidden');
    return;
  }

  showScreen('game');
  $('my-score').textContent = mine.score;

  const pos = state.queue.findIndex(q => q.id === me.playerId);
  const hasWinner = state.roundLocked && state.winner;
  let cls, text;

  if (hasWinner) {
    if (state.winner.id === me.playerId) {
      cls = 'state-winner';
      text = '¡Ganaste la ronda!';
    } else {
      cls = 'state-locked';
      text = `Ganó ${state.winner.name}`;
    }
  } else if (mine.status === 'eliminated') {
    cls = 'state-eliminated';
    text = 'Eliminado de esta ronda. Esperá la siguiente canción';
  } else if (pos >= 0) {
    cls = 'state-queued';
    text = `¡Apretaste! Estás ${pos + 1}° para adivinar`;
  } else if (!state.roundStarted) {
    cls = 'state-wait';
    text = 'Esperá la señal del anfitrión';
  } else {
    cls = 'state-active';
    text = '¡TOCÁ!';
  }

  PAD.className = `pad ${cls}`;
  PAD_TEXT.textContent = text;
  showWinnerInfo(hasWinner ? state.winner : null);
}
function renderFinal() {
  const list = state.standings || [];
  const leaders = list.filter(s => s.rank === 1);
  $('final-headline').textContent = !list.length
    ? 'Sin jugadores'
    : leaders.length === 1
      ? `Ganó ${leaders[0].name}`
      : 'Empate en el primer puesto';
  $('final-list').innerHTML = list.length
    ? list.map(s => `
        <li class="final-row ${s.id === me.playerId ? 'me' : ''}">
          <span class="fpos">${medal(s.rank)}</span>
          <span class="fname">${esc(s.name)}${s.id === me.playerId ? ' (vos)' : ''}</span>
          <span class="fpts">${s.score} pts</span>
        </li>`).join('')
    : '<li class="muted">Sin jugadores</li>';
}
function medal(rank) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `${rank}°`;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}


