'use strict';
// Testes da lógica de score, calendário e notícias com dados simulados (sem rede).
const assert = require('assert');
const { computeAll, eventRisk, labelOf } = require('./score');
const { parseRss, classify } = require('./news');

const q = (price, chg1d, chg5d, extra = {}) => ({ ok: true, price, chg1d, chg5d, chg20d: chg5d * 2, a20: chg5d > 0, a50: chg5d > 0, abs1d: 0, abs5d: 0, ...extra });

function market(kind) {
  const up = kind === 'bull' ? 1 : -1;
  const Q = {
    'NQ=F': q(21000, 1.4 * up, 3.5 * up), 'ES=F': q(6000, 1.0 * up, 2.5 * up), 'YM=F': q(44000, 0.8 * up, 2 * up), 'RTY=F': q(2300, 1.3 * up, 3 * up),
    QQQ: q(500, 1.4 * up, 3.5 * up), SPY: q(600, 1 * up, 2.5 * up), QQQE: q(100, 1.1 * up, 3 * up), RSP: q(170, 1.2 * up, 2.8 * up),
    '^VIX': q(up > 0 ? 13 : 31, -8 * up, -20 * up), '^VIX3M': q(up > 0 ? 17 : 27, 0, 0), '^VVIX': q(up > 0 ? 85 : 125, 0, 0), '^SKEW': q(up > 0 ? 128 : 158, 0, 0),
    '^TNX': q(4.2, 0, 0, { abs1d: -0.05 * up, abs5d: -0.12 * up }), 'DX-Y.NYB': q(100, -0.5 * up, -1.2 * up), 'USDJPY=X': q(150, 0.8 * up, 2 * up),
    HYG: q(80, 0.3 * up, 1 * up), LQD: q(110, 0 * up, 0.1 * up),
    XLK: q(1, 1.6 * up, 4 * up), XLY: q(1, 1.2 * up, 3 * up), XLF: q(1, 1 * up, 2 * up), XLI: q(1, 1 * up, 2 * up), XLC: q(1, 1.2 * up, 3 * up),
    XLV: q(1, -0.5 * up, -1 * up), XLU: q(1, -0.7 * up, -1 * up), XLP: q(1, -0.4 * up, -1 * up),
    IWF: q(1, 1.5 * up, 3.5 * up), IWD: q(1, 0.6 * up, 1.5 * up), SPHB: q(1, 2 * up, 5 * up), SPLV: q(1, 0 * up, 0 * up), ARKK: q(1, 2.5 * up, 6 * up), SMH: q(1, 2 * up, 5 * up),
    '^N225': q(1, 1.5 * up, 3 * up), '^GDAXI': q(1, 1 * up, 2 * up), '^HSI': q(1, 1.2 * up, 3 * up),
    'GC=F': q(1, -0.5 * up, -1 * up), 'CL=F': q(1, 0.5 * up, 1 * up), 'HG=F': q(1, 1.5 * up, 4 * up), 'BTC-USD': q(1, 3 * up, 8 * up),
  };
  return Q;
}

const now = Date.parse('2026-11-05T12:00:00Z');
const H = 3600e3;
const nfp = { title: 'Non-Farm Employment Change', currency: 'USD', time: Date.parse('2026-11-06T13:30:00Z'), impact: 'High' };

// 1. Mercado fortemente comprador atinge faixas altas e não passa de 100
let r = computeAll(market('bull'), [], now);
assert(r.day.score >= 60 && r.day.score <= 100, 'bull dia: ' + r.day.score);
assert(r.week.score >= 60 && r.week.score <= 100, 'bull semana: ' + r.week.score);
assert.strictEqual(r.day.coverage, 100);
console.log('bull  -> dia', r.day.score, r.day.label, '| semana', r.week.score, '| regime', r.regime);

// 2. Mercado fortemente vendedor
r = computeAll(market('bear'), [], now);
assert(r.day.score <= -60 && r.day.score >= -100, 'bear dia: ' + r.day.score);
assert.strictEqual(r.regime, 'Risk Off');
console.log('bear  -> dia', r.day.score, r.day.label, '| semana', r.week.score, '| regime', r.regime);

// 3. Sem dados: score 0, cobertura 0, sem erro
r = computeAll({}, [], now);
assert.strictEqual(r.day.score, 0);
assert.strictEqual(r.day.coverage, 0);
assert.strictEqual(r.day.confidence, 0);
console.log('vazio -> dia', r.day.score, 'cobertura', r.day.coverage);

// 4. Dados parciais (só índices): cobertura parcial, sem NaN
const part = { 'NQ=F': q(21000, 1, 2), 'ES=F': q(6000, 0.8, 1.5) };
r = computeAll(part, [], now);
assert(r.day.coverage > 0 && r.day.coverage < 100);
assert(!Number.isNaN(r.day.score));
assert.strictEqual(r.day.label, 'DADOS INSUFICIENTES');
console.log('parcial -> cobertura', r.day.coverage, 'score', r.day.score);

// 5. Juros subindo com ações firmes e VIX caindo: penalidade reduzida
const A = market('bull');
A['^TNX'] = q(4.4, 0, 0, { abs1d: 0.12, abs5d: 0.2 });
const damped = computeAll(A, [], now).blocks.find((b) => b.id === 'ratesfx');
const B = market('bull');
B['^TNX'] = q(4.4, 0, 0, { abs1d: 0.12, abs5d: 0.2 });
B['NQ=F'] = q(21000, -0.5, -1); B['^VIX'] = q(18, 5, 10);
const notDamped = computeAll(B, [], now).blocks.find((b) => b.id === 'ratesfx');
assert(damped.day > notDamped.day, 'amortecimento dos juros');
assert(damped.notes.some((n) => n.includes('crescimento')));
console.log('juros -> com crescimento', damped.day, '| sem', notDamped.day);

// 6. Risco de evento
assert.strictEqual(eventRisk([nfp], now).level, 'moderado');
assert.strictEqual(eventRisk([nfp], nfp.time - 10 * H).level, 'alto');
assert.strictEqual(eventRisk([nfp], nfp.time - 2 * H).level, 'extremo');
assert.strictEqual(eventRisk([nfp], nfp.time + 0.5 * H).level, 'extremo'); // acabou de sair
assert.strictEqual(eventRisk([nfp], nfp.time + 5 * H).level, 'baixo');
assert.strictEqual(eventRisk([], now).level, 'baixo');
const low = computeAll(market('bull'), [], now).day.confidence;
const high = computeAll(market('bull'), [nfp], nfp.time - 2 * H).day.confidence;
assert(high < low, 'evento reduz confiança');
console.log('confiança sem evento', low, '| 2h antes do NFP', high);

// 7. Divergência: Nasdaq sobe com VIX subindo
const D = market('bull');
D['^VIX'] = q(20, 6, 10);
assert(computeAll(D, [], now).flags.some((x) => x.includes('VIX também sobe')));

// 8. Rótulos
assert.strictEqual(labelOf(25), 'COMPRADOR MODERADO');
assert.strictEqual(labelOf(24), 'NEUTRO / SEM VANTAGEM');
assert.strictEqual(labelOf(-60), 'VENDEDOR FORTE');

// 9. Notícias: parsing, decodificação e classificação
const xml = `<rss><channel>
<item><title>Fed signals rate cut pause as inflation surprise rattles Treasury yields - Reuters</title><link>https://example.com/a</link><pubDate>Thu, 05 Nov 2026 10:00:00 GMT</pubDate><source url="https://reuters.com">Reuters</source></item>
<item><title>Chef says &quot;fed up&quot; with local menu - Food Blog</title><link>https://example.com/b</link><pubDate>Thu, 05 Nov 2026 10:00:00 GMT</pubDate></item>
<item><title>Tariffs on chips and Iran missile strike send oil surging - Bloomberg</title><link>https://example.com/c</link><pubDate>Thu, 05 Nov 2026 11:00:00 GMT</pubDate></item>
<item><title>Item sem link valido - X</title><link>javascript:alert(1)</link><pubDate>Thu, 05 Nov 2026 11:00:00 GMT</pubDate></item>
</channel></rss>`;
const items = parseRss(xml);
assert.strictEqual(items.length, 3, 'descarta link inválido');
assert.strictEqual(items[0].source, 'Reuters');
assert(!items[0].title.endsWith('Reuters'));
const c = items.map((i) => classify(i, now));
assert(c[0].flagged && c[0].cats.some((x) => x.id === 'fed') && c[0].cats.some((x) => x.id === 'dados'));
assert(!c[1].flagged && c[1].cats.length === 0, '"fed up" em minúsculas não conta como Fed');
assert(c[2].flagged && c[2].horizon === 'semana');
console.log('notícias -> relevantes:', c.filter((x) => x.flagged).length, 'de', c.length);

console.log('\nTodos os testes passaram.');

// 10. Dia de queda forte (Nasdaq -3%): tem de dar VENDEDOR FORTE, mesmo com juros caindo e Ásia/Europa neutras
{
  const q2 = (p, a, b, x = {}) => ({ ok: true, price: p, chg1d: a, chg5d: b, chg20d: b * 2, a20: true, a50: true, abs1d: 0, abs5d: 0, spark: [], ...x });
  const S = {
    'NQ=F': q2(20000, -3.1, -2), 'ES=F': q2(5900, -2.4, -1.5), 'YM=F': q2(43000, -1.6, -1), 'RTY=F': q2(2200, -2.2, -1.5),
    QQQ: q2(1, -3.1, -2), SPY: q2(1, -2.4, -1.5), QQQE: q2(1, -2.5, -1.6), RSP: q2(1, -1.9, -1.2),
    '^VIX': q2(23, 28, 18), '^VIX3M': q2(24, 0, 0), '^VVIX': q2(110, 0, 0), '^SKEW': q2(142, 0, 0),
    '^TNX': q2(4.3, 0, 0, { abs1d: -0.08, abs5d: -0.1 }), 'DX-Y.NYB': q2(100, 0.2, 0.3), 'USDJPY=X': q2(150, -0.5, -1),
    HYG: q2(1, -0.5, -0.6), LQD: q2(1, 0.1, 0),
    XLK: q2(1, -3.5, -2), XLY: q2(1, -2.8, -1.5), XLF: q2(1, -1.8, -1), XLI: q2(1, -1.6, -1), XLC: q2(1, -2.6, -1.5), XLV: q2(1, -0.9, -0.5), XLU: q2(1, -0.5, 0), XLP: q2(1, -0.6, 0),
    IWF: q2(1, -3.2, -2), IWD: q2(1, -1.5, -1), SPHB: q2(1, -4, -3), SPLV: q2(1, -0.8, -0.3), ARKK: q2(1, -4.5, -4), SMH: q2(1, -5, -3),
    '^N225': q2(1, -0.3, 0.5), '^GDAXI': q2(1, 0.2, 0.4), '^HSI': q2(1, 0.1, 0.3),
    'GC=F': q2(1, 0.6, 1), 'CL=F': q2(1, -1, -2), 'HG=F': q2(1, -1, -1), 'BTC-USD': q2(1, -3, -4),
  };
  const rs = computeAll(S, [], now);
  assert(rs.day.score <= -60, 'queda de 3% deve ser forte: ' + rs.day.score);
  assert.strictEqual(rs.day.label, 'VENDEDOR FORTE');
  assert(rs.flags[0].includes('ancorado'), 'avisa que o score foi ancorado no preço');
  const rates = rs.blocks.find((b) => b.id === 'ratesfx');
  assert(rates.day <= 0, 'juros caindo em pânico não pode ser positivo: ' + rates.day);
  assert.strictEqual(rs.regime, 'Risk Off');
  console.log('queda 3%  -> dia', rs.day.score, rs.day.label, '(antes do ajuste:', rs.day.rawScore + ')');

  // Dia normal (-0,4%) não deve ser ancorado
  const N = JSON.parse(JSON.stringify(S));
  for (const k of Object.keys(N)) { N[k].chg1d *= 0.12; N[k].chg5d *= 0.3; }
  const rn = computeAll(N, [], now);
  assert(!rn.day.anchored, 'dia comum não é ancorado');

  // Alta forte simétrica
  const U = JSON.parse(JSON.stringify(S));
  for (const k of Object.keys(U)) { U[k].chg1d *= -1; U[k].chg5d *= -1; }
  U['^VIX'] = q2(14, -20, -10); U['^TNX'].abs1d = 0.02;
  const ru = computeAll(U, [], now);
  assert(ru.day.score >= 60, 'alta de 3% deve ser forte: ' + ru.day.score);
  console.log('alta 3%   -> dia', ru.day.score, ru.day.label);
}
console.log('\nTestes de calibração passaram.');

// ---------- Reação do mercado às manchetes ----------
{
  const { reactionFor, barStats, summarize, alertLevel } = require('./reaction');
  const STEP = 60000;
  const T0 = Date.parse('2026-11-09T10:00:00Z');
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  // Passeio aleatório de 1 min com volatilidade 0,03%/barra; jump = {at: índice da barra, pct}
  function mkBars(n, jump, gap) {
    const out = [];
    let p = 20000;
    for (let i = 0; i < n; i++) {
      if (gap && i >= gap[0] && i < gap[1]) continue;
      p *= 1 + (gauss() * 0.03) / 100;
      if (jump) {
        const k = i - jump.at;
        if (k >= 0 && k < 3) p *= 1 + jump.pct / 3 / 100; // choque em 3 barras
      }
      out.push({ t: T0 + i * STEP, c: p });
    }
    return out;
  }
  const react = (bars, t0) => reactionFor(bars, barStats(bars), t0);
  const both = (jump, t0, gap) => {
    seed = 777; const nq = mkBars(600, jump, gap);
    seed = 999; const es = mkBars(600, jump && { at: jump.at, pct: jump.pct * 0.8 }, gap);
    return { nq, es, r1: react(nq, t0), r2: react(es, t0) };
  };

  // 1. Notícia seguida de queda de 0,9%: reação forte, direção de queda, 3 janelas fechadas
  const tNews = T0 + 300 * STEP;
  let a = both({ at: 301, pct: -0.9 }, tNews);
  let s = summarize(a.r1, a.r2);
  assert.strictEqual(a.r1.status, 'ok');
  assert(a.r1.windows.every((w) => w.done), 'janelas fechadas');
  assert(a.r1.windows[1].chg < -0.7, 'queda de 15 min: ' + a.r1.windows[1].chg);
  assert.strictEqual(s.level, 'forte');
  assert.strictEqual(s.dir, -1);
  assert(!s.late);
  console.log('reação  -> NQ 15m', a.r1.windows[1].chg.toFixed(2) + '%', 'z', a.r1.windows[1].z.toFixed(1), '|', s.level, 'dir', s.dir);

  // 2. Sem choque: não pode dar reação forte
  a = both(null, tNews);
  s = summarize(a.r1, a.r2);
  assert(s.level !== 'forte', 'dia calmo não é reação forte: ' + s.level);
  console.log('calmo   ->', s.level, 'zmin', s.zmin);

  // 3. Notícia recente demais (3 min antes do fim dos dados): aguardando
  const tFresh = T0 + 597 * STEP;
  a = both(null, tFresh);
  s = summarize(a.r1, a.r2);
  assert.strictEqual(s.level, 'pendente');
  assert(a.r1.now && a.r1.now.min >= 1, 'mostra variação parcial até agora');

  // 4. Notícia durante buraco nos dados (mercado fechado)
  a = both(null, T0 + 350 * STEP, [300, 450]);
  s = summarize(a.r1, a.r2);
  assert.strictEqual(s.level, 'fechado');

  // 5. Mercado já tinha caído 10 min ANTES da manchete: marcar possível atraso da fonte
  a = both({ at: 290, pct: -0.9 }, T0 + 300 * STEP);
  s = summarize(a.r1, a.r2);
  assert(s.late, 'manchete atrasada deve ser sinalizada (preZ ' + s.preZ + ', nível ' + s.level + ')');
  console.log('atrasada->', s.level, 'preZ', s.preZ, 'late', s.late);

  // 6. Índices em direções opostas
  seed = 5; const up = mkBars(600, { at: 301, pct: +0.9 });
  seed = 6; const dn = mkBars(600, { at: 301, pct: -0.9 });
  s = summarize(react(up, tNews), react(dn, tNews));
  assert.strictEqual(s.level, 'divergente');

  // 7. Só um índice com dados
  s = summarize(react(dn, tNews), { status: 'sem-dados' });
  assert.strictEqual(s.level, 'forte');
  assert.strictEqual(summarize({ status: 'sem-dados' }, { status: 'sem-dados' }).level, 'sem-dados');

  // 8. Nível de alerta
  const cats = [{ id: 'fed', label: 'Fed / juros' }];
  const calm = { level: 'nenhuma' }, strong = { level: 'forte', late: false }, strongLate = { level: 'forte', late: true };
  assert.strictEqual(alertLevel({ cats, flagged: true, surprise: true, ageH: 1 }, calm), 'red');
  assert.strictEqual(alertLevel({ cats, flagged: true, surprise: false, ageH: 1 }, calm), 'amber');
  assert.strictEqual(alertLevel({ cats, flagged: false, surprise: false, ageH: 1 }, strong), 'red');
  assert.strictEqual(alertLevel({ cats, flagged: false, surprise: false, ageH: 1 }, strongLate), null);
  assert.strictEqual(alertLevel({ cats: [], flagged: false, surprise: false, ageH: 1 }, strong), null);
  assert.strictEqual(alertLevel({ cats, flagged: true, surprise: true, ageH: 30 }, calm), 'amber');
  const { classify } = require('./news');
  const c1 = classify({ title: 'Fed shocks markets with unexpected emergency rate cut', link: 'https://x.com', time: Date.now() - 600000 });
  assert(c1.surprise && c1.flagged, 'manchete de choque deve ser relevante e inesperada');
  const c2 = classify({ title: 'Fed officials discuss balance sheet in routine speech', link: 'https://x.com', time: Date.now() - 600000 });
  assert(!c2.surprise, 'discurso de rotina não é inesperado');
  console.log('\nTestes de reação passaram.');
}
