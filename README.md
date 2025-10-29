# Fortnite Tracker (robusto)

Scraper robusto con Playwright que lee el **`<time datetime>` real** de [Fortnite Tracker](https://fortnitetracker.com), guarda sesiones por jugador **solo cuando aparece match nuevo**, **cierra sesiones por inactividad** y muestra todo en una **mini web** en `http://localhost:8080`.

Incluye:
- Tabla de **quién está jugando ahora** (ventana de actividad: 30 minutos, configurable)
- **Última partida detectada** (jugador, ID y hora)
- **Sesiones** por jugador (inicio, fin y duración)
- **Solapes** (intervalos con 2, 3 o 4 jugadores simultáneamente) y totales
- Todas las horas **Europe/Madrid**

## Requisitos

- Node.js 18+
- Chromium de Playwright (se instala con el comando de abajo)

## Instalación

```bash
cd fortnite-tracker-robusto
npm i
npx playwright install chromium
```

> En Linux, si faltan dependencias del navegador, puedes usar `npx playwright install --with-deps chromium`.

## Uso

```bash
npm start
# Abre: http://localhost:8080
```

El servicio hace scraping cada 60s y persiste los datos en `data.json` (mismo directorio).

## Configuración

- Cambia la inactividad (cierre de sesión) en `index.js`:
  ```js
  const INACTIVITY_MINUTES = 30;
  ```
- Jugadores y URLs están al principio del archivo `index.js`.

## Notas técnicas

- **Robustez de scraping**: se abren páginas en Playwright, se esperan `time[datetime]` o enlaces a `/match/`, y se escanea el DOM para emparejar cada enlace con el `<time datetime>` más cercano; se elige el **máximo por fecha**.
- **Guardar solo si hay match nuevo**: se compara por `matchId` (extraído del enlace `/match/...`).
- **Sesiones**: se abren con el primer match tras inactividad y se cierran cuando pasan `INACTIVITY_MINUTES` sin partidas nuevas (la hora de fin se fija en la hora real del último match).
- **Solapes**: se calculan por barrido de eventos, con desglose (exactamente 2, 3 o 4 jugadores).
- **Zona horaria**: las fechas se guardan en UTC y se formatean a `Europe/Madrid` para la UI.

## Problemas típicos

- **Timeouts**: La red o la web puede tardar. Se reintenta hasta 3 veces por jugador y se bloquean imágenes/fuentes para mayor estabilidad.
- **Bloqueos**: Si ves muchos fallos seguidos, sube el intervalo de scraping o baja la concurrencia (ya se hace secuencial).
- **Cambios de DOM**: Si cambian los selectores, ajusta la lógica en `scrapeLatestMatch`.
