#!/usr/bin/env node
'use strict';
/*
 * Nasdaq Macro Compass v2 - servidor local (Node 18+, sem dependências).
 * Uso: node server.js  ->  abra http://localhost:8787
 *
 * Fontes (todas públicas e sem chave):
 *  - Cotações: Yahoo Finance (endpoint não oficial, pode atrasar ou limitar)
 *  - Calendário econômico: feed semanal da Faireconomy (mesmo do ForexFactory)
 *  - Notícias: Google News RSS
 * O navegador só fala com este servidor, então não há problema de CORS.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { computeAll } = require('./score');
const { fetchNews } = require('./news');
const { reactionFor, barStats, summarize, alertLevel } = require('./reaction');
const zlib = require('zlib');
const crypto = require('crypto');
const { computeLevels } = require('./levels');
const { movers, ratesInfo } = require('./extras');
const { structural } = require('./structural');

const PORT = Number(process.env.PORT) || 8787;
const UA = 'Mozilla/5.0 (compatible; NasdaqCompass/2.0)';
// Intervalos pensados para gastar pouco no plano grátis: o servidor só busca dados quando alguém abre o painel
// (nada roda em segundo plano) e reaproveita o que já buscou dentro destes prazos.
const TTL = { quotes: 90e3, news: 5 * 60e3, calendar: 20 * 60e3, intraday: 120e3 };
const INTRADAY_SYMBOLS = ['NQ=F', 'ES=F'];
const CACHE_DIR = path.join(__dirname, '.cache');

const SYMBOLS = [
  'NQ=F', 'ES=F', 'YM=F', 'RTY=F', 'QQQ', 'SPY', 'QQQE', 'RSP',
  '^VIX', '^VIX3M', '^VVIX', '^SKEW',
  '^TNX', 'DX-Y.NYB', 'USDJPY=X', 'HYG', 'LQD',
  'XLK', 'XLY', 'XLF', 'XLI', 'XLC', 'XLV', 'XLU', 'XLP',
  'IWF', 'IWD', 'SPHB', 'SPLV', 'ARKK', 'SMH',
  '^N225', '^GDAXI', '^HSI',
  'GC=F', 'CL=F', 'HG=F', 'BTC-USD',
  '^MOVE', '^IRX', '^FVX', '^TYX',
  'NVDA', 'MSFT', 'AAPL', 'AMZN', 'AVGO', 'GOOGL', 'META', 'TSLA', 'NFLX', 'COST',
];
// Estes só precisam da variação do dia: busca curta (5 dias) em vez de 6 meses, o que poupa banda.
const LIGHT = new Set(['^MOVE', '^IRX', '^FVX', '^TYX', 'NVDA', 'MSFT', 'AAPL', 'AMZN', 'AVGO', 'GOOGL', 'META', 'TSLA', 'NFLX', 'COST']);

// Usado só se o feed do calendário e o cache em disco falharem. Datas confirmadas em calendários públicos, sem previsão.
const FALLBACK_EVENTS = [
  { title: 'Nonfarm Payrolls (out/2026)', currency: 'USD', time: Date.parse('2026-11-06T13:30:00Z'), impact: 'High', forecast: '', previous: '' },
  { title: 'CPI (out/2026)', currency: 'USD', time: Date.parse('2026-11-10T13:30:00Z'), impact: 'High', forecast: '', previous: '' },
  { title: 'PPI (out/2026)', currency: 'USD', time: Date.parse('2026-11-13T13:30:00Z'), impact: 'High', forecast: '', previous: '' },
];

const state = {
  quotes: {},
  quotesT: 0,
  news: { t: 0, items: [], okCount: 0, total: 0 },
  calendar: { t: 0, events: [], source: 'none' },
  intraday: {}, // { 'NQ=F': { bars: [{t, o, h, l, c}], interval, asOf } }
  intradayT: 0,
  levels: {}, // { NQ, ES } níveis do dia calculados das barras
};
let inflight = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

async function getText(url, ms = 10000, headers = {}) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally {
    clearTimeout(to);
  }
}

async function pool(tasks, n) {
  let i = 0;
  const run = async () => { while (i < tasks.length) await tasks[i++](); };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, run));
}

function saveCache(name, obj) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(path.join(CACHE_DIR, name + '.json'), JSON.stringify(obj)); } catch (_) {}
}
function loadCache(name) {
  try { return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, name + '.json'), 'utf8')); } catch (_) { return null; }
}

async function fetchSymbol(sym) {
  const q = `/v8/finance/chart/${encodeURIComponent(sym)}?range=${LIGHT.has(sym) ? '5d' : '6mo'}&interval=1d`;
  let txt;
  try { txt = await getText('https://query1.finance.yahoo.com' + q); }
  catch (_) { await sleep(400); txt = await getText('https://query2.finance.yahoo.com' + q); }
  const j = JSON.parse(txt);
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error('sem dados');
  const ts = r.timestamp || [];
  const cl = (r.indicators && r.indicators.quote && r.indicators.quote[0].close) || [];
  const bars = [];
  for (let i = 0; i < ts.length; i++) if (cl[i] != null) bars.push({ t: ts[i], c: cl[i] });
  if (!bars.length) throw new Error('sem barras');
  const last = bars[bars.length - 1];
  const price = num(r.meta.regularMarketPrice) ?? last.c;
  const mt = r.meta.regularMarketTime || last.t;
  const hist = bars.map((b) => b.c);
  // A última barra é a sessão atual (ou a última sessão, se o mercado está fechado)?
  const lastIsCurrent = mt - last.t >= 0 && mt - last.t < 86400;
  const series = (lastIsCurrent ? hist.slice(0, -1) : hist).concat(price);
  const n = series.length;
  const pct = (k) => (n > k ? (price / series[n - 1 - k] - 1) * 100 : null);
  const sma = (k) => (n >= k ? series.slice(-k).reduce((s, x) => s + x, 0) / k : null);
  const s20 = sma(20), s50 = sma(50);
  return {
    ok: true,
    price,
    chg1d: pct(1), chg5d: pct(5), chg20d: pct(20),
    abs1d: n > 1 ? price - series[n - 2] : null,
    abs5d: n > 5 ? price - series[n - 6] : null,
    a20: s20 == null ? null : price > s20,
    a50: s50 == null ? null : price > s50,
    asOf: mt * 1000,
    spark: series.slice(-30),
  };
}

async function refreshQuotes() {
  const tasks = SYMBOLS.map((s) => async () => {
    try {
      const d = await fetchSymbol(s);
      d.t = Date.now();
      state.quotes[s] = d;
    } catch (e) {
      const old = state.quotes[s];
      if (old && old.ok && Date.now() - old.t < 20 * 60e3) old.stale = true;
      else state.quotes[s] = { ok: false, err: String((e && e.message) || e) };
    }
  });
  await pool(tasks, 8);
  state.quotesT = Date.now();
}

async function refreshNews() {
  try {
    const r = await fetchNews(getText);
    if (r.okCount > 0) state.news = { t: Date.now(), ...r };
    else throw new Error('nenhuma consulta respondeu');
  } catch (_) {
    state.news.t = Date.now() - TTL.news + 60e3; // tenta de novo em 1 minuto
  }
}

async function refreshCalendar() {
  const urls = ['thisweek', 'nextweek'].map((w) => `https://nfs.faireconomy.media/ff_calendar_${w}.json`);
  const res = await Promise.allSettled(urls.map((u) => getText(u, 12000)));
  const events = [];
  let ok = false;
  res.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    try {
      const arr = JSON.parse(r.value);
      if (!Array.isArray(arr)) return;
      if (i === 0) ok = true;
      for (const e of arr) {
        const time = Date.parse(e.date);
        if (isFinite(time)) events.push({ title: e.title, currency: e.country, time, impact: e.impact, forecast: e.forecast || '', previous: e.previous || '' });
      }
    } catch (_) {}
  });
  if (ok && events.length) {
    state.calendar = { t: Date.now(), events, source: 'faireconomy', ok: true };
    saveCache('calendar', state.calendar);
    return;
  }
  const retry = Date.now() - TTL.calendar + 60e3;
  if (state.calendar.events.length && state.calendar.source === 'faireconomy') { state.calendar.t = retry; state.calendar.ok = false; return; }
  const c = loadCache('calendar');
  if (c && c.events && c.events.length) state.calendar = { ...c, t: retry, source: 'cache', ok: false };
  else state.calendar = { t: retry, events: FALLBACK_EVENTS, source: 'fallback', ok: false };
}

// Barras de 1 minuto (ou 5 se o Yahoo recusar) dos últimos 5 dias, para medir a reação às manchetes.
async function fetchIntraday(sym) {
  let lastErr;
  for (const [iv, rg] of [['1m', '5d'], ['5m', '5d']]) {
    try {
      const q = `/v8/finance/chart/${encodeURIComponent(sym)}?range=${rg}&interval=${iv}&includePrePost=true`;
      let txt;
      try { txt = await getText('https://query1.finance.yahoo.com' + q, 15000); }
      catch (_) { txt = await getText('https://query2.finance.yahoo.com' + q, 15000); }
      const r = JSON.parse(txt).chart.result[0];
      const ts = r.timestamp || [];
      const qt = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
      const cl = qt.close || [], op = qt.open || [], hi = qt.high || [], lo = qt.low || [];
      const bars = [];
      for (let i = 0; i < ts.length; i++) {
        if (cl[i] == null) continue;
        bars.push({ t: ts[i] * 1000, o: op[i] ?? cl[i], h: hi[i] ?? cl[i], l: lo[i] ?? cl[i], c: cl[i] });
      }
      if (bars.length >= 60) return { bars, interval: iv, asOf: bars[bars.length - 1].t };
      lastErr = new Error('poucas barras');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('sem barras');
}

async function refreshIntraday() {
  await Promise.all(
    INTRADAY_SYMBOLS.map(async (s) => {
      try {
        state.intraday[s] = await fetchIntraday(s);
        state.levels[s === 'NQ=F' ? 'NQ' : 'ES'] = computeLevels(state.intraday[s].bars); // calculado aqui, não a cada pedido
      } catch (_) { /* mantém as barras e os níveis anteriores, se houver */ }
    })
  );
  state.intradayT = Date.now();
}

function ensureFresh() {
  if (inflight) return inflight;
  const now = Date.now();
  const jobs = [];
  if (now - state.intradayT > TTL.intraday) jobs.push(refreshIntraday());
  if (now - state.quotesT > TTL.quotes) jobs.push(refreshQuotes());
  if (now - state.news.t > TTL.news) jobs.push(refreshNews());
  if (now - state.calendar.t > TTL.calendar) jobs.push(refreshCalendar());
  if (!jobs.length) return Promise.resolve();
  inflight = Promise.allSettled(jobs).finally(() => { inflight = null; });
  return inflight;
}

function build() {
  const now = Date.now();
  const res = computeAll(state.quotes, state.calendar.events, now);
  const majors = ['USD', 'EUR', 'GBP', 'JPY', 'CNY'];
  const calendar = state.calendar.events
    .filter((e) => (e.impact === 'High' && majors.includes(e.currency)) || (e.impact === 'Holiday' && e.currency === 'USD'))
    .filter((e) => e.time >= now - 6 * 3600e3 && e.time <= now + 8 * 86400e3)
    .sort((a, b) => a.time - b.time);
  const slim = {};
  for (const [s, q] of Object.entries(state.quotes)) {
    slim[s] = q.ok
      ? { ok: true, price: q.price, chg1d: q.chg1d, chg5d: q.chg5d, abs1d: q.abs1d, stale: !!q.stale, spark: q.spark, asOf: q.asOf }
      : { ok: false, err: q.err };
  }
  const symbolsOk = SYMBOLS.filter((s) => state.quotes[s] && state.quotes[s].ok).length;
  const nowItems = state.news.items.map((n) => ({ ...n, ageH: (now - n.time) / 3600e3 }));

  // Manchetes relevantes das últimas 24h com a reação do NQ e do ES depois de cada uma.
  const iNQ = state.intraday['NQ=F'], iES = state.intraday['ES=F'];
  const stNQ = iNQ && barStats(iNQ.bars), stES = iES && barStats(iES.bars);
  const usdHigh = state.calendar.events.filter((e) => e.impact === 'High' && e.currency === 'USD');
  const live = nowItems
    .filter((n) => n.ageH <= 24 && (n.cats.length || n.flagged))
    .map((n) => {
      const nq = reactionFor(iNQ && iNQ.bars, stNQ, n.time);
      const es = reactionFor(iES && iES.bars, stES, n.time);
      const sum = summarize(nq, es);
      const near = usdHigh.find((e) => Math.abs(e.time - n.time) <= 10 * 60e3);
      return { ...n, react: { nq, es, sum }, alert: alertLevel(n, sum), eventNear: near ? near.title : null };
    })
    .sort((a, b) => b.time - a.time)
    .slice(0, 40);
  const lastBar = Math.max(0, ...[iNQ, iES].filter(Boolean).map((x) => x.asOf));
  return {
    generatedAt: now,
    quotes: slim,
    ...res,
    calendar,
    news: nowItems.slice(0, 40),
    live,
    levels: { NQ: state.levels.NQ || null, ES: state.levels.ES || null },
    movers: movers(state.quotes),
    rates: ratesInfo(state.quotes),
    structural: structural(now),
    health: {
      intraday: iNQ || iES ? `${(iNQ || iES).interval}` : null,
      intradayAgeMin: lastBar ? Math.round((now - lastBar) / 60000) : null,
      symbolsOk,
      symbolsTotal: SYMBOLS.length,
      calendarSource: state.calendar.source,
      calendarOk: !!state.calendar.ok,
      newsOk: state.news.okCount,
      newsTotal: state.news.total,
      quotesAgeSec: state.quotesT ? Math.round((now - state.quotesT) / 1000) : null,
    },
  };
}

// ---- Respostas: compressão gzip e ETag, para gastar pouca banda e CPU ----
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|manifest))/;
function respond(req, res, type, entry, cacheControl, status = 200) {
  const h = { 'Content-Type': type, 'Cache-Control': cacheControl, Vary: 'Accept-Encoding', 'X-Content-Type-Options': 'nosniff' };
  if (entry.etag) {
    h.ETag = entry.etag;
    if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, h); return res.end(); }
  }
  let body = entry.buf;
  if (COMPRESSIBLE.test(type) && body.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    if (!entry.gz) entry.gz = zlib.gzipSync(body);
    body = entry.gz;
    h['Content-Encoding'] = 'gzip';
  }
  h['Content-Length'] = body.length;
  res.writeHead(status, h);
  res.end(body);
}

// Só estes arquivos são servidos (lista fechada, sem leitura de caminhos arbitrários).
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8', 'no-cache'],
  '/index.html': ['index.html', 'text/html; charset=utf-8', 'no-cache'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8', 'public, max-age=86400'],
  '/sw.js': ['sw.js', 'application/javascript; charset=utf-8', 'no-cache'],
  '/icons/icon-192.png': ['icons/icon-192.png', 'image/png', 'public, max-age=604800'],
  '/icons/icon-512.png': ['icons/icon-512.png', 'image/png', 'public, max-age=604800'],
  '/icons/icon-maskable-512.png': ['icons/icon-maskable-512.png', 'image/png', 'public, max-age=604800'],
  '/icons/apple-touch-icon.png': ['icons/apple-touch-icon.png', 'image/png', 'public, max-age=604800'],
  '/apple-touch-icon.png': ['icons/apple-touch-icon.png', 'image/png', 'public, max-age=604800'],
  '/favicon.ico': ['icons/icon-192.png', 'image/png', 'public, max-age=604800'],
};
const fileCache = new Map();
function loadStatic(rel) {
  if (!fileCache.has(rel)) {
    const buf = fs.readFileSync(path.join(__dirname, rel));
    fileCache.set(rel, { buf, gz: null, etag: '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"' });
  }
  return fileCache.get(rel);
}

// O mesmo JSON serve quem abrir o painel nos próximos 15 segundos (evita refazer e recomprimir).
let apiCache = { t: 0, entry: null };
function apiEntry() {
  const now = Date.now();
  if (!apiCache.entry || now - apiCache.t > 15e3) apiCache = { t: now, entry: { buf: Buffer.from(JSON.stringify(build())), gz: null } };
  return apiCache.entry;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = (req.url || '/').split('?')[0];
    if (url === '/api/dashboard') {
      await ensureFresh();
      return respond(req, res, 'application/json; charset=utf-8', apiEntry(), 'no-store');
    }
    if (url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('ok');
    }
    const st = STATIC[url];
    if (st) {
      let entry;
      try { entry = loadStatic(st[0]); } catch (_) { entry = null; }
      if (entry) return respond(req, res, st[1], entry, st[2]);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Não encontrado');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
});

if (require.main === module) {
  // Em hospedagem na nuvem a porta vem da variável PORT e o servidor precisa escutar em 0.0.0.0.
  // Rodando local (sem PORT), continua só em 127.0.0.1.
  const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
  server.listen(PORT, HOST, () => {
    // Sem busca na inicialização: o servidor só trabalha quando alguém abre o painel.
    console.log(`Nasdaq Macro Compass v2 rodando em ${HOST}:${PORT}`);
  });
}

module.exports = { build, state, server };
