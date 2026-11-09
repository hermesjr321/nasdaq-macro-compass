'use strict';
/*
 * Reação do mercado a manchetes (NQ e ES).
 *
 * Entrada: barras intraday [{t: ms de início, c: fechamento}] e o horário da manchete.
 * Saída: variação % do preço após 5, 15 e 60 min, medida em "desvios" da volatilidade local
 * (os 120 minutos anteriores à manchete), e um veredito combinando os dois índices.
 *
 * Limites que valem para a leitura:
 *  - O horário da manchete é o do feed de notícias (Google News), que pode atrasar em relação à fonte
 *    original. Por isso medimos também os 15 min ANTES: se o mercado já se movia, a manchete pode ter chegado tarde.
 *  - Reagiu depois não prova que reagiu por causa da notícia. Eventos do calendário, abertura de bolsas e
 *    outras manchetes no mesmo minuto se misturam.
 *  - Os limiares (2 e 3 desvios) são heurísticas minhas, não foram validados com histórico.
 */

const MIN = 60000;
const WINDOWS = [5, 15, 60];
const PRE_MIN = 15;
const STRONG = 3;
const MODERATE = 2;
const LOOKBACK_BARS = 120;

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};

function stepOf(bars) {
  const d = [];
  for (let i = Math.max(1, bars.length - 300); i < bars.length; i++) {
    const x = bars[i].t - bars[i - 1].t;
    if (x > 0) d.push(x);
  }
  return median(d) || MIN;
}

function rmsReturns(bars, from, to, step) {
  let s = 0, n = 0;
  for (let i = Math.max(1, from); i <= to && i < bars.length; i++) {
    if (bars[i].t - bars[i - 1].t > 3 * step) continue; // pula buracos (fim de semana, pausa)
    const r = (bars[i].c / bars[i - 1].c - 1) * 100;
    if (isFinite(r)) { s += r * r; n++; }
  }
  return { rms: n ? Math.sqrt(s / n) : 0, n };
}

function barStats(bars) {
  if (!bars || bars.length < 30) return null;
  const step = stepOf(bars);
  const g = rmsReturns(bars, 1, bars.length - 1, step);
  return { step, global: Math.max(g.rms, 0.005) };
}

// índice da última barra JÁ FECHADA em T (início + passo <= T); -1 se nenhuma
function lastClosedIdx(bars, step, T) {
  let lo = 0, hi = bars.length - 1, r = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t + step <= T) { r = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return r;
}

function reactionFor(bars, stats, t0) {
  if (!bars || !stats) return { status: 'sem-dados' };
  const step = stats.step;
  const stepMin = step / MIN;
  const tol = Math.max(3 * step, 10 * MIN);
  const endLast = bars[bars.length - 1].t + step;
  if (t0 < bars[0].t + step) return { status: 'sem-dados' };
  const i0 = lastClosedIdx(bars, step, t0);
  if (i0 < 0) return { status: 'sem-dados' };
  if (t0 - (bars[i0].t + step) > tol) return { status: 'fechado' };

  const p0 = bars[i0].c;
  const loc = rmsReturns(bars, i0 - LOOKBACK_BARS + 1, i0, step);
  const sigma = Math.max(loc.n >= 20 ? loc.rms : stats.global, stats.global * 0.4, 0.005); // % por barra
  const zOf = (chg, minutes) => chg / (sigma * Math.sqrt(Math.max(minutes / stepMin, 1)));

  const windows = WINDOWS.map((W) => {
    const T = t0 + W * MIN;
    if (T > endLast) return { min: W, done: false };
    const j = lastClosedIdx(bars, step, T);
    if (j < 0 || T - (bars[j].t + step) > tol) return { min: W, done: false, gap: true };
    const chg = (bars[j].c / p0 - 1) * 100;
    return { min: W, done: true, chg, z: zOf(chg, W) };
  });

  let pre = null;
  const Tp = t0 - PRE_MIN * MIN;
  const jp = lastClosedIdx(bars, step, Tp);
  if (jp >= 0 && Tp - (bars[jp].t + step) <= tol) {
    const chg = (p0 / bars[jp].c - 1) * 100;
    pre = { min: PRE_MIN, chg, z: zOf(chg, PRE_MIN) };
  }

  const elapsed = (endLast - t0) / MIN;
  const lastC = bars[bars.length - 1].c;
  const nowChg = (lastC / p0 - 1) * 100;
  const now = elapsed >= 1 ? { min: Math.round(elapsed), chg: nowChg, z: zOf(nowChg, elapsed) } : null;

  return { status: 'ok', p0, sigma, windows, pre, now };
}

// Combina NQ e ES num veredito único.
function summarize(nq, es) {
  const ok = (r) => r && r.status === 'ok';
  if (!ok(nq) && !ok(es)) {
    const closed = (nq && nq.status === 'fechado') || (es && es.status === 'fechado');
    return { level: closed ? 'fechado' : 'sem-dados' };
  }
  const best = (r) => {
    if (!ok(r)) return null;
    const w = r.windows.filter((x) => x.done);
    return w.length ? w.reduce((a, b) => (Math.abs(b.z) > Math.abs(a.z) ? b : a)) : null;
  };
  const picks = [best(nq), best(es)].filter(Boolean);
  const preZ = Math.max(0, ...[nq, es].filter(ok).map((r) => (r.pre ? Math.abs(r.pre.z) : 0)));
  if (!picks.length) return { level: 'pendente', preZ, late: false };

  const signs = picks.map((p) => Math.sign(p.chg));
  const sameSign = signs.every((s) => s === signs[0]);
  const zmin = Math.min(...picks.map((p) => Math.abs(p.z)));
  const zmax = Math.max(...picks.map((p) => Math.abs(p.z)));
  const dir = sameSign ? signs[0] : Math.sign(picks.reduce((a, p) => (Math.abs(p.z) > Math.abs(a.z) ? p : a)).chg);

  let level;
  if (!sameSign && zmax >= MODERATE && picks.length > 1) level = 'divergente';
  else if (zmin >= STRONG) level = 'forte';
  else if (zmin >= MODERATE) level = 'moderada';
  else level = 'nenhuma';

  const late = preZ >= MODERATE && preZ >= zmax;
  return { level, dir, zmin: +zmin.toFixed(1), preZ: +preZ.toFixed(1), late };
}

/*
 * Nível de alerta de uma manchete.
 *  vermelho: relevante E inesperada (palavras de surpresa/choque, recente), ou a reação nos dois índices foi forte
 *            logo após uma manchete de tema macro, sem sinal de que o mercado já se movia antes.
 *  amarelo : relevante, ou reação moderada.
 */
function alertLevel(item, sum) {
  const hasCats = item.cats && item.cats.length > 0;
  const surprise = item.flagged && item.surprise && item.ageH <= 12;
  const reacted = hasCats && sum.level === 'forte' && !sum.late && item.ageH <= 24;
  if (surprise || reacted) return 'red';
  if (item.flagged || (hasCats && sum.level === 'moderada')) return 'amber';
  return null;
}

module.exports = { reactionFor, barStats, summarize, alertLevel, WINDOWS, STRONG, MODERATE };
