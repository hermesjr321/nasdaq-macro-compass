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
