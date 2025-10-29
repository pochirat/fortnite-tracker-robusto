const fmt = (iso) => {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('es-ES', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid'
    }).format(new Date(iso));
  } catch { return iso; }
};

const fmtDur = (ms) => {
  const sec = Math.floor(ms/1000);
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const s = sec%60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
};

async function loadState() {
  const res = await fetch('/api/state', { cache: 'no-store' });
  return res.json();
}

function renderPlayingNow(players) {
  const tbody = document.querySelector('#playingNowTable tbody');
  tbody.innerHTML = '';
  for (const p of players) {
    const tr = document.createElement('tr');
    const playing = p.playingNow;
    tr.innerHTML = `
      <td>${p.name}</td>
      <td class="nowrap">${fmt(p.lastMatchAtLocal)}</td>
      <td>${playing ? '<span class="badge live">Sí</span>' : '<span class="badge idle">No</span>'}</td>
      <td class="nowrap"><a href="${p.url}" target="_blank" rel="noopener">/matches</a></td>
    `;
    tbody.appendChild(tr);
  }
}

function renderLastMatch(latest) {
  const div = document.getElementById('lastMatch');
  if (!latest) { div.textContent = '—'; return; }
  div.innerHTML = `
    <strong>${latest.player}</strong> · Match <code>${latest.matchId}</code>
    · ${fmt(latest.at)}
  `;
}

function renderSessions(players) {
  const host = document.getElementById('sessions');
  host.innerHTML = '';
  for (const p of players) {
    const wrap = document.createElement('div');
    wrap.className = 'player';
    const title = document.createElement('h3');
    title.textContent = p.name;
    wrap.appendChild(title);

    const table = document.createElement('table');
    table.className = 'sessionTable';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Inicio</th>
          <th>Fin</th>
          <th class="right">Duración</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');

    for (const s of p.sessions.slice().reverse().slice(0, 20)) {
      const start = fmt(s.start);
      const end = s.end ? fmt(s.end) : (p.playingNow ? '<span class="badge live">en curso</span>' : '—');
      let dur = '—';
      if (s.end) {
        const ms = new Date(s.end) - new Date(s.start);
        if (ms > 0) dur = fmtDur(ms);
      } else if (p.playingNow) {
        const ms = Date.now() - new Date(s.start).getTime();
        if (ms > 0) dur = fmtDur(ms);
      }
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="nowrap">${start}</td><td class="nowrap">${end}</td><td class="right">${dur}</td>`;
      tbody.appendChild(tr);
    }

    wrap.appendChild(table);
    host.appendChild(wrap);
  }
}

function renderOverlaps(overlaps) {
  const sum = overlaps.summary;
  const div = document.getElementById('overlapsSummary');

  const parts = [];
  if (sum.twoOrMoreMs > 0) parts.push(`<strong>Total 2+:</strong> ${fmtDur(sum.twoOrMoreMs)}`);
  parts.push(`2 jugadores: ${fmtDur(sum.exactly2Ms)}`);
  parts.push(`3 jugadores: ${fmtDur(sum.exactly3Ms)}`);
  parts.push(`4 jugadores: ${fmtDur(sum.exactly4Ms)}`);

  div.innerHTML = parts.join(' · ');

  const tbody = document.querySelector('#overlapsTable tbody');
  tbody.innerHTML = '';
  for (const o of overlaps.intervals.slice().reverse().slice(0, 30)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="nowrap">${fmt(o.start)}</td>
      <td class="nowrap">${fmt(o.end)}</td>
      <td class="right">${fmtDur(o.durationMs)}</td>
      <td>${o.players.join(', ')}</td>
      <td>${o.count}</td>
    `;
    tbody.appendChild(tr);
  }
}

async function tick() {
  try {
    const data = await loadState();
    document.getElementById('status').textContent =
      `Revisión: ${fmt(new Date().toISOString())} · Zona: ${data.tz}`;
    renderPlayingNow(data.players);
    renderLastMatch(data.latestMatch);
    renderSessions(data.players);
    renderOverlaps(data.overlaps);
  } catch (e) {
    document.getElementById('status').textContent = 'Error actualizando. Reintentando...';
  }
}

tick();
setInterval(tick, 15000);
