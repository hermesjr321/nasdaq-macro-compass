'use strict';
/*
 * Níveis de preço do contexto diário (NQ e ES), calculados das barras de 1 minuto.
 *
 * Dia de negociação dos futuros: começa às 18:00 ET (domingo à noite para a segunda) e termina às 17:00 ET.
 * Referências, todas em horário de Nova York (ET), com horário de verão tratado pelo Intl:
 *   - máxima, mínima e fechamento do dia de negociação anterior;
 *   - fechamento da sessão regular (16:00 ET) do dia anterior;
 *   - abertura de 00:00 ET;
 *   - faixa asiática (20:00 a 00:00 ET) e faixa de Londres (02:00 a 05:00 ET), definição usada em ICT;
 *   - máxima, mínima e abertura da semana (desde o domingo à noite).
 * "Varredura" = o preço passou de um nível e voltou para o lado de dentro dele.
 * As janelas asiática e de Londres são convenções; se você usa outras, ajuste ASIA_FROM_H, LON_FROM_H e LON_TO_H.
 */

const ASIA_FROM_H = 20;
const LON_FROM_H = 2;
const LON_TO_H = 5;

const ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

function etClock(ms) {
  const p = {};
  for (const x of ET.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hh: (+p.hour) % 24, mm: +p.minute };
}
const addDay = (ds, n) => {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const tdOf = (c) => (c.hh >= 18 ? addDay(c.date, 1) : c.date);
const fmtP = (x) => x.toLocaleString('en-US', { maximumFractionDigits: 2 });

function range(arr) {
  if (!arr.length) return null;
  let high = -Infinity, low = Infinity;
  for (const x of arr) { if (x.h > high) high = x.h; if (x.l < low) low = x.l; }
  return { high, low };
}

function computeLevels(bars) {
  if (!bars || bars.length < 60) return null;
  const ann = bars.map((b) => {
    const c = etClock(b.t);
    const h = b.h != null ? b.h : b.c, l = b.l != null ? b.l : b.c, o = b.o != null ? b.o : b.c;
    return { t: b.t, o, h, l, c: b.c, d: c.date, hh: c.hh, mm: c.mm, td: tdOf(c) };
  });
  const last = ann[ann.length - 1];
  const td = last.td;
  const groups = new Map();
  for (const b of ann) {
    if (!groups.has(b.td)) groups.set(b.td, []);
    groups.get(b.td).push(b);
  }
  const days = [...groups.keys()].sort();
  const cur = groups.get(td);

  // Dia anterior COMPLETO (pelo menos 20h de dados), para não usar uma sobra do início da janela
  let prev = null;
  for (let i = days.indexOf(td) - 1; i >= 0; i--) {
    const g = groups.get(days[i]);
    if (g[g.length - 1].t - g[0].t >= 20 * 3600e3) {
      prev = { date: days[i], ...range(g), close: g[g.length - 1].c };
      const rth = g.filter((x) => x.d === days[i] && x.hh < 16);
      if (rth.length) prev.rthClose = rth[rth.length - 1].c;
      break;
    }
  }

  const today = { date: td, open: cur[0].o, ...range(cur) };
  const calToday = cur.filter((x) => x.d === td);
  const midnight = calToday.length && calToday[0].hh === 0 ? calToday[0].o : null;

  const asiaBars = cur.filter((x) => x.d === addDay(td, -1) && x.hh >= ASIA_FROM_H);
  const asia = asiaBars.length
    ? { ...range(asiaBars), done: !(last.d === addDay(td, -1) && last.hh >= ASIA_FROM_H) }
    : null;
  const lonBars = cur.filter((x) => x.d === td && x.hh >= LON_FROM_H && x.hh < LON_TO_H);
  const london = lonBars.length
    ? { ...range(lonBars), done: !(last.d === td && last.hh >= LON_FROM_H && last.hh < LON_TO_H) }
    : null;

  // Semana: desde o último intervalo de 24h ou mais (fim de semana), ou desde o início se ele já for domingo à noite
  let ws = 0;
  for (let i = 1; i < ann.length; i++) if (ann[i].t - ann[i - 1].t >= 24 * 3600e3) ws = i;
  const wFirst = ann[ws];
  const wDow = new Date(wFirst.d + 'T12:00:00Z').getUTCDay();
  const week = ws > 0 || (wDow === 0 && wFirst.hh >= 18) ? { open: wFirst.o, ...range(ann.slice(ws)) } : null;

  const P = last.c;
  const levels = [];
  const add = (id, label, price) => { if (price != null && isFinite(price)) levels.push({ id, label, price }); };
  if (prev) {
    add('pdh', 'Máxima de ontem (PDH)', prev.high);
    add('pdl', 'Mínima de ontem (PDL)', prev.low);
    add('rth', 'Fechamento regular de ontem (16h ET)', prev.rthClose);
  }
  add('mid', 'Abertura de 00:00 ET', midnight);
  if (asia) {
    add('ah', 'Máxima asiática' + (asia.done ? '' : ' (em andamento)'), asia.high);
    add('al', 'Mínima asiática' + (asia.done ? '' : ' (em andamento)'), asia.low);
  }
  if (london) {
    add('lh', 'Máxima de Londres' + (london.done ? '' : ' (em andamento)'), london.high);
    add('ll', 'Mínima de Londres' + (london.done ? '' : ' (em andamento)'), london.low);
  }
  add('tdh', 'Máxima de hoje', today.high);
  add('tdl', 'Mínima de hoje', today.low);
  if (week) {
    add('wo', 'Abertura da semana', week.open);
    add('wh', 'Máxima da semana', week.high);
    add('wl', 'Mínima da semana', week.low);
  }
  for (const l of levels) {
    l.pts = +(l.price - P).toFixed(2);
    l.distPct = +((l.price / P - 1) * 100).toFixed(3);
  }

  // Posição do preço e varreduras
  const position = [];
  const sweeps = [];
  if (prev) {
    if (P > prev.high) position.push(`Preço acima da máxima de ontem (${fmtP(prev.high)}).`);
    else if (P < prev.low) position.push(`Preço abaixo da mínima de ontem (${fmtP(prev.low)}).`);
    else position.push(`Preço dentro do range de ontem, a ${Math.round(((P - prev.low) / (prev.high - prev.low || 1)) * 100)}% da mínima para a máxima.`);
    if (today.high > prev.high && P <= prev.high) sweeps.push(`Varreu a máxima de ontem (${fmtP(prev.high)}) e voltou para baixo dela.`);
    if (today.low < prev.low && P >= prev.low) sweeps.push(`Varreu a mínima de ontem (${fmtP(prev.low)}) e voltou para cima dela.`);
  }
  if (midnight != null) position.push(`Preço ${P >= midnight ? 'acima' : 'abaixo'} da abertura de 00:00 ET (${fmtP(midnight)}).`);
  if (asia && asia.done) {
    const post = range(calToday);
    if (P > asia.high) position.push(`Preço acima da máxima asiática (${fmtP(asia.high)}).`);
    else if (P < asia.low) position.push(`Preço abaixo da mínima asiática (${fmtP(asia.low)}).`);
    else position.push('Preço dentro da faixa asiática.');
    if (post && post.high > asia.high && P <= asia.high) sweeps.push(`Varreu a máxima asiática (${fmtP(asia.high)}) depois das 00:00 ET e voltou para dentro.`);
    if (post && post.low < asia.low && P >= asia.low) sweeps.push(`Varreu a mínima asiática (${fmtP(asia.low)}) depois das 00:00 ET e voltou para dentro.`);
  }
  if (london && london.done) {
    const post = range(cur.filter((x) => x.d === td && x.hh >= LON_TO_H));
    if (post && post.high > london.high && P <= london.high) sweeps.push(`Varreu a máxima de Londres (${fmtP(london.high)}) e voltou para dentro.`);
    if (post && post.low < london.low && P >= london.low) sweeps.push(`Varreu a mínima de Londres (${fmtP(london.low)}) e voltou para dentro.`);
  }
  if (prev && prev.rthClose != null) {
    const g = (P / prev.rthClose - 1) * 100;
    position.push(`Desde o fechamento regular de ontem: ${g > 0 ? '+' : ''}${g.toFixed(2)}%.`);
  }

  return { td, last: P, asOf: last.t, levels, position, sweeps, prev, today, asia, london, week };
}

module.exports = { computeLevels, etClock, tdOf, addDay };
