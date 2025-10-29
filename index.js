/**
 * Fortnite Tracker - versión robusta
 * - Scraping con Playwright del <time datetime> real
 * - Guarda solo si hay match nuevo (por ID)
 * - Cierra sesiones por inactividad
 * - Mini web en http://localhost:8080
 * - Horas mostradas en Europe/Madrid
 *
 * Requisitos:
 *   - Node 18+
 *   - npx playwright install chromium
 */
import express from 'express';
import { chromium, devices } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DateTime } from 'luxon';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ========= Config =========
const PORT = 8080;
const INACTIVITY_MINUTES = 30;      // inactividad para cerrar sesión
const SCRAPE_INTERVAL_MS = 60_000;  // frecuencia de scraping
const TZ = 'Europe/Madrid';

const PLAYERS = [
  { name: 'Zumito Kun', url: 'https://fortnitetracker.com/profile/all/Zumito%20Kun/matches' },
  { name: 'Lulau22', url: 'https://fortnitetracker.com/profile/all/Lulau22/matches' },
  { name: 'Antocar69 TTV', url: 'https://fortnitetracker.com/profile/all/Antocar69%20TTV/matches' },
  { name: 'Cronoxis', url: 'https://fortnitetracker.com/profile/all/Cronoxis/matches' },
];

// ========= Estado & persistencia =========
const DATA_FILE = path.join(__dirname, 'data.json');

/** Estado persistente mínimo */
function defaultState() {
  const players = {};
  for (const p of PLAYERS) {
    players[p.name] = {
      name: p.name,
      url: p.url,
      lastMatchId: null,
      lastMatchAt: null, // ISO (UTC)
      sessions: []       // [{ start: ISO, end: ISO|null }]
    };
  }
  return {
    players,
    latestMatch: null,     // { player, matchId, at: ISO }
    createdAt: new Date().toISOString()
  };
}

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      // asegurar todos los jugadores presentes
      for (const p of PLAYERS) {
        if (!parsed.players?.[p.name]) {
          parsed.players[p.name] = {
            name: p.name, url: p.url, lastMatchId: null, lastMatchAt: null, sessions: []
          };
        } else {
          parsed.players[p.name].url = p.url; // actualizar URL por si acaso
        }
      }
      return parsed;
    }
  } catch (e) {
    console.error('[WARN] No se pudo leer data.json, iniciando vacío:', e);
  }
  return defaultState();
}

function saveState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.error('[ERROR] Guardando data.json:', e);
  }
}

let state = loadState();

// ========= Utiles de tiempo =========
function isoToDT(iso) {
  return iso ? DateTime.fromISO(iso, { zone: 'utc' }) : null;
}

function nowUtc() {
  return DateTime.utc();
}

function minutesBetween(aISO, bISO) {
  const a = isoToDT(aISO);
  const b = isoToDT(bISO);
  if (!a || !b) return null;
  return Math.abs(b.diff(a, 'minutes').minutes);
}

function fmt(iso) {
  if (!iso) return '-';
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(TZ).toFormat('yyyy-LL-dd HH:mm:ss');
}

function fmtDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ========= Playwright (scraping robusto) =========
let browser;
let context;

async function setupBrowser() {
  browser = await chromium.launch({ headless: true });
  const iPhone = devices['Desktop Chrome'];
  context = await browser.newContext({
    ...iPhone,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  // Bloquear recursos pesados para mayor estabilidad
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'media' || type === 'font') {
      route.abort();
    } else {
      route.continue();
    }
  });
}

async function teardownBrowser() {
  if (context) await context.close();
  if (browser) await browser.close();
}

/**
 * Extrae el match más reciente con su <time datetime> real y el ID de match de /match/xxxxx
 * Retorna: { matchId, atISO } (UTC) o null si falla
 */
async function scrapeLatestMatch(url) {
  const page = await context.newPage();
  page.setDefaultTimeout(45000);

  // pequeña aleatoriedad para evadir caches simples
  const navUrl = `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      // Espera flexible: primero por algún <time datetime>, si no aparece, espera por algún enlace de match
      await Promise.race([
        page.waitForSelector('time[datetime]', { state: 'attached', timeout: 20000 }),
        page.waitForSelector('a[href*="/match/"]', { state: 'attached', timeout: 20000 }),
      ]).catch(() => {});

      // Evalúa DOM buscando el match con fecha más reciente y que tenga enlace /match/
      const info = await page.evaluate(() => {
        // Tomamos todos los enlaces a /match/ y buscamos el time[datetime] asociado más cercano
        const links = Array.from(document.querySelectorAll('a[href*="/match/"]'));
        let best = null;
        for (const a of links) {
          // Buscar un contenedor cercano que también tenga time[datetime]
          let container = a.closest('article, li, tr, div, section') || a;
          let timeEl = container.querySelector('time[datetime]');
          // fallback: busca en ancestros
          if (!timeEl) {
            let parent = a.parentElement;
            for (let i = 0; i < 4 && parent && !timeEl; i++) {
              timeEl = parent.querySelector?.('time[datetime]') || null;
              parent = parent.parentElement;
            }
          }
          const dt = timeEl?.getAttribute('datetime')?.trim();
          const href = a.getAttribute('href') || '';
          const idMatch = href.split('/match/')[1]?.split(/[?#]/)[0]?.trim();
          if (!dt || !idMatch) continue;

          const t = Date.parse(dt);
          if (!isNaN(t)) {
            if (!best || t > best.ts) {
              best = { ts: t, atISO: new Date(t).toISOString(), matchId: idMatch };
            }
          }
        }
        return best ? { matchId: best.matchId, atISO: best.atISO } : null;
      });

      if (info?.matchId && info?.atISO) {
        await page.close();
        return info;
      }
      // si no encontró, hacemos un pequeño delay y reintento
      await new Promise(r => setTimeout(r, 1500 + Math.random()*1000));
    } catch (e) {
      // reintentar con backoff suave
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }

  await page.close();
  return null;
}

// ========= Lógica de sesiones =========
function ensureSessionOnNewMatch(player, matchAtISO) {
  const p = state.players[player];
  const sessions = p.sessions;
  const last = sessions[sessions.length - 1];

  if (!last || last.end) {
    // No hay sesión abierta -> abrir con inicio en matchAtISO
    sessions.push({ start: matchAtISO, end: null });
  } else {
    // Ya había sesión abierta -> nada
  }
}

function closeInactiveSessions() {
  const nowIso = nowUtc().toISO();
  for (const p of Object.values(state.players)) {
    const lastAt = p.lastMatchAt;
    const sessions = p.sessions;
    const last = sessions[sessions.length - 1];
    if (!last || last.end) continue; // no hay sesión abierta

    if (!lastAt) {
      // sesión abierta pero no tenemos última partida -> cerrar por seguridad al inicio
      last.end = nowIso;
      continue;
    }
    const mins = minutesBetween(lastAt, nowIso);
    if (mins !== null && mins > INACTIVITY_MINUTES) {
      // cerramos la sesión en el momento de la última partida (más fiel)
      last.end = lastAt;
    }
  }
}

function isPlayingNow(p) {
  if (!p.lastMatchAt) return false;
  const mins = minutesBetween(p.lastMatchAt, nowUtc().toISO());
  return mins !== null && mins <= INACTIVITY_MINUTES;
}

// ========= Cómputo de solapes =========
/**
 * Devuelve:
 *  {
 *    summary: { exactly2Ms, exactly3Ms, exactly4Ms, twoOrMoreMs },
 *    intervals: [ { start, end, durationMs, players: [names], count } ]  // solo con count>=2 (máx 100 últimos)
 *  }
 */
function computeOverlaps() {
  // Construir eventos (sweep line)
  const events = [];
  for (const p of Object.values(state.players)) {
    for (const s of p.sessions) {
      const start = isoToDT(s.start);
      const end = s.end ? isoToDT(s.end) : (isPlayingNow(p) ? nowUtc() : null);
      if (!start) continue;
      if (!end) continue; // ignoramos sesiones abiertas si no está jugando ahora
      events.push({ t: start.toMillis(), type: +1, who: p.name });
      events.push({ t: end.toMillis(), type: -1, who: p.name });
    }
  }
  events.sort((a, b) => a.t === b.t ? (a.type - b.type) : (a.t - b.t)); // cerrar antes que abrir en el mismo instante

  const active = new Set();
  const intervals = [];
  let prevT = null;

  for (const ev of events) {
    if (prevT !== null && active.size >= 2) {
      const segStart = prevT;
      const segEnd = ev.t;
      if (segEnd > segStart) {
        intervals.push({
          start: new Date(segStart).toISOString(),
          end: new Date(segEnd).toISOString(),
          durationMs: segEnd - segStart,
          players: Array.from(active),
          count: active.size,
        });
      }
    }

    if (ev.type === -1) {
      active.delete(ev.who);
    } else if (ev.type === +1) {
      active.add(ev.who);
    }
    prevT = ev.t;
  }

  // Resumen
  let exactly2Ms = 0, exactly3Ms = 0, exactly4Ms = 0;
  for (const seg of intervals) {
    if (seg.count === 2) exactly2Ms += seg.durationMs;
    else if (seg.count === 3) exactly3Ms += seg.durationMs;
    else if (seg.count >= 4) exactly4Ms += seg.durationMs;
  }
  const twoOrMoreMs = exactly2Ms + exactly3Ms + exactly4Ms;

  // solo los últimos 100 para no inflar respuesta
  const trimmed = intervals.slice(-100);

  return {
    summary: { exactly2Ms, exactly3Ms, exactly4Ms, twoOrMoreMs },
    intervals: trimmed
  };
}

// ========= Ciclo de scraping =========
async function scanAll() {
  for (const p of PLAYERS) {
    const info = await scrapeLatestMatch(p.url);
    if (!info) {
      console.warn(`[WARN] No se pudo leer última partida de ${p.name}`);
      continue;
    }
    const prevId = state.players[p.name].lastMatchId;
    const prevAt = state.players[p.name].lastMatchAt;

    // Guardar solo si hay match nuevo
    if (info.matchId !== prevId) {
      state.players[p.name].lastMatchId = info.matchId;
      state.players[p.name].lastMatchAt = info.atISO;
      ensureSessionOnNewMatch(p.name, info.atISO);
      state.latestMatch = { player: p.name, matchId: info.matchId, at: info.atISO };
      console.log(`[${new Date().toISOString()}] Nuevo match ${p.name} -> ${info.matchId} @ ${info.atISO}`);
      saveState();
    } else {
      // Sin cambios -> nada
    }
  }

  // Cerrar sesiones por inactividad si toca
  closeInactiveSessions();
  saveState();
}

// ========= Express (mini web) =========
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (req, res) => {
  // Construir payload agradable para la UI
  const now = nowUtc().toISO();
  const players = Object.values(state.players).map(p => ({
    name: p.name,
    url: p.url,
    lastMatchId: p.lastMatchId,
    lastMatchAt: p.lastMatchAt,
    lastMatchAtLocal: p.lastMatchAt ? DateTime.fromISO(p.lastMatchAt, { zone: 'utc' }).setZone(TZ).toISO() : null,
    playingNow: isPlayingNow(p),
    sessions: p.sessions
  }));

  const overlaps = computeOverlaps();

  res.json({
    nowUtc: now,
    tz: TZ,
    latestMatch: state.latestMatch,
    players,
    overlaps
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========= Arranque (hotfix: levantar server primero) =========
async function main() {
  console.log(`[${new Date().toISOString()}] Servidor web: http://localhost:${PORT}`);

  // 1) Levantar Express inmediatamente, así localhost:8080 responde ya
  app.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] Mini web servida en /`);
  });

  // 2) Iniciar Playwright y el tracker en segundo plano (sin tumbar el proceso si falla)
  try {
    await setupBrowser();
    console.log(`[${new Date().toISOString()}] Tracker iniciado...`);

    // primer escaneo inmediato (si falla, no matamos el proceso)
    try {
      await scanAll();
    } catch (e) {
      console.error('Primer scan falló:', e);
    }

    // luego periódico
    setInterval(() => {
      scanAll().catch(e => console.error('Scan error:', e));
    }, SCRAPE_INTERVAL_MS);

  } catch (e) {
    console.error('Playwright no pudo iniciar. La web sigue accesible, pero sin scraping.', e);
    // Nota: puedes más tarde hacer un reintento, o mostrar un botón en la UI para reintentar.
  }
}

process.on('SIGINT', async () => { await teardownBrowser(); process.exit(0); });
process.on('SIGTERM', async () => { await teardownBrowser(); process.exit(0); });

main().catch(async (e) => {
  console.error('Fatal inesperado:', e);
  await teardownBrowser();
  process.exit(1);
});

