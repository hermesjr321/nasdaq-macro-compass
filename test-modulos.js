'use strict';
// Testes dos módulos de contexto: níveis do dia, Nasdaq por ação, juros e calendário estrutural.
const assert = require('assert');
const { computeLevels, etClock, tdOf } = require('./levels');
const { movers, ratesInfo } = require('./extras');
const { structural, thirdFriday, lastWeekday } = require('./structural');

// ---------- Horário de Nova York e dia de negociação ----------
{
  const w = etClock(Date.parse('2026-11-08T23:00:00Z')); // domingo 18:00 ET (horário padrão, UTC-5)
  assert.deepStrictEqual([w.date, w.hh, w.mm], ['2026-11-08', 18, 0]);
  assert.strictEqual(tdOf(w), '2026-11-09'); // domingo à noite já é o pregão de segunda
  const s = etClock(Date.parse('2026-07-01T22:00:00Z')); // verão (UTC-4)
  assert.strictEqual(s.hh, 18);
  assert.strictEqual(etClock(Date.parse('2026-11-09T05:00:00Z')).hh, 0); // meia-noite, não 24
}

// ---------- Níveis do dia ----------
const MIN = 60000;
function path(keys) { // [[ISO, preço]...] interpolado minuto a minuto; h = l = o = c para extremos exatos
  const out = [];
  for (let k = 0; k < keys.length - 1; k++) {
    const t0 = Date.parse(keys[k][0]), t1 = Date.parse(keys[k + 1][0]);
    for (let t = t0; t < t1; t += MIN) {
      const p = keys[k][1] + ((keys[k + 1][1] - keys[k][1]) * (t - t0)) / (t1 - t0);
      out.push({ t, o: p, h: p, l: p, c: p });
    }
  }
  const lk = keys[keys.length - 1];
  out.push({ t: Date.parse(lk[0]), o: lk[1], h: lk[1], l: lk[1], c: lk[1] });
  return out;
}
const fri = path([
  ['2026-11-05T23:00:00Z', 20700], ['2026-11-06T06:00:00Z', 20600], ['2026-11-06T16:00:00Z', 21000],
  ['2026-11-06T20:59:00Z', 20850], ['2026-11-06T22:00:00Z', 20800],
]);
const mon = path([
  ['2026-11-08T23:00:00Z', 20800], ['2026-11-09T01:00:00Z', 20810], ['2026-11-09T03:00:00Z', 20780], ['2026-11-09T04:59:00Z', 20830],
  ['2026-11-09T05:00:00Z', 20830], ['2026-11-09T07:00:00Z', 20800], ['2026-11-09T08:00:00Z', 20860], ['2026-11-09T09:00:00Z', 20760],
  ['2026-11-09T09:59:00Z', 20790], ['2026-11-09T10:00:00Z', 20790], ['2026-11-09T13:00:00Z', 21010], ['2026-11-09T15:00:00Z', 20950],
]);
{
  const L = computeLevels([...fri, ...mon]);
  assert.strictEqual(L.td, '2026-11-09');
  assert.strictEqual(L.prev.date, '2026-11-06');
  assert.strictEqual(L.prev.high, 21000);
  assert.strictEqual(L.prev.low, 20600);
  assert.strictEqual(L.prev.close, 20800);
  assert.strictEqual(L.prev.rthClose, 20850, 'fechamento regular = barra das 15:59 ET');
  assert.deepStrictEqual([L.asia.high, L.asia.low, L.asia.done], [20830, 20780, true]);
  assert.deepStrictEqual([L.london.high, L.london.low, L.london.done], [20860, 20760, true]);
  assert.strictEqual(L.week.open, 20800);
  assert.strictEqual(L.week.high, 21010);
  assert.strictEqual(L.week.low, 20760);
  assert.strictEqual(L.last, 20950);
  const mid = L.levels.find((l) => l.id === 'mid');
  assert.strictEqual(mid.price, 20830, 'abertura de 00:00 ET');
  assert.strictEqual(L.levels.length, 13);
  const pdh = L.levels.find((l) => l.id === 'pdh');
  assert.strictEqual(pdh.pts, 50); // 21000 - 20950
  // Máxima de ontem (21.000) varrida pelo pico de 21.010; mínima asiática (20.780) varrida pela queda de Londres a 20.760.
  assert.strictEqual(L.sweeps.length, 2, 'varreduras: ' + JSON.stringify(L.sweeps));
  assert(L.sweeps.some((x) => x.includes('máxima de ontem')));
  assert(L.sweeps.some((x) => x.includes('mínima asiática')));
  assert(!L.sweeps.some((x) => x.includes('Londres')), 'a faixa de Londres não foi varrida');
  assert(L.position.some((x) => x.includes('acima da máxima asiática')));
  assert(L.position.some((x) => x.includes('dentro do range de ontem')));
  console.log('níveis   -> PDH', L.prev.high, '| asiática', L.asia.low + '-' + L.asia.high, '| varreduras:', L.sweeps.length, '|', L.position[0]);

  // Londres ainda em andamento (corta os dados às 08:00Z = 03:00 ET)
  const cut = [...fri, ...mon].filter((b) => b.t <= Date.parse('2026-11-09T08:00:00Z'));
  const L2 = computeLevels(cut);
  assert.strictEqual(L2.london.done, false);
  assert(L2.levels.find((l) => l.id === 'lh').label.includes('em andamento'));
  // Poucos dados: não calcula
  assert.strictEqual(computeLevels(mon.slice(0, 10)), null);
  assert.strictEqual(computeLevels(null), null);
}

// ---------- Quem puxa o Nasdaq ----------
{
  const q = (chg) => ({ ok: true, price: 100, chg1d: chg, chg5d: 0 });
  const Q = { 'NQ=F': q(-2.0), NVDA: q(-4), MSFT: q(-2), AAPL: q(-1), AMZN: q(-2.5), AVGO: q(-5), GOOGL: q(-1), META: q(-3), TSLA: q(1), NFLX: q(-0.5), COST: q(0.2) };
  const m = movers(Q);
  assert.strictEqual(m.rows.length, 10);
  assert.strictEqual(m.rows[0].sym, 'NVDA', 'maior contribuição primeiro (9% x -4%)');
  assert.strictEqual(m.rows[0].contrib, -0.36);
  assert(m.share > 0.3 && m.share < 1.2, 'fração do índice: ' + m.share);
  assert.strictEqual(m.up, 2);
  assert.strictEqual(movers({ 'NQ=F': q(-2), NVDA: q(1) }), null, 'poucos dados: não mostra');
  assert.strictEqual(movers({ ...Q, 'NQ=F': q(0.1) }).share, null, 'índice parado: sem fração');
  console.log('movers   -> top:', m.rows[0].sym, m.rows[0].contrib + ' pp', '| explica', Math.round(m.share * 100) + '% do movimento');
}

// ---------- Juros e estresse ----------
{
  const q = (price, abs1d, chg1d = 0) => ({ ok: true, price, abs1d, chg1d });
  const Q = { '^IRX': q(4.30, 0.01), '^FVX': q(4.60, -0.02), '^TNX': q(4.88, -0.014), '^TYX': q(5.10, -0.02), '^MOVE': q(125, 0, 4.2), HYG: q(77, 0, -0.45), LQD: q(110, 0, 0.1) };
  const r = ratesInfo(Q);
  assert.strictEqual(r.y10.y, 4.88);
  assert.strictEqual(r.y10.d1, -1.4);
  assert.strictEqual(r.c10_3m.pp, 0.58);
  assert.strictEqual(r.c10_3m.label, 'positiva');
  assert.strictEqual(r.c10_3m.d1, -2.4); // (-1.4) - (+1.0)
  assert.strictEqual(r.move.state, 'estresse');
  assert.strictEqual(ratesInfo({ '^MOVE': q(80, 0, 0) }).move.state, 'calmo');
  const inv = ratesInfo({ '^IRX': q(5.0, 0), '^TNX': q(4.5, 0) });
  assert.strictEqual(inv.c10_3m.label, 'invertida');
  const legacy = ratesInfo({ '^TNX': q(48.8, -0.14) }); // formato antigo (x10)
  assert.strictEqual(legacy.y10.y, 4.88);
  assert.strictEqual(legacy.y10.d1, -1.4);
  assert.strictEqual(ratesInfo({}), null);
  console.log('juros    -> 10Y', r.y10.y + '%', r.y10.d1 + 'bp', '| 10Y-3M', r.c10_3m.pp + 'pp', r.c10_3m.label, '| MOVE', r.move.state);
}

// ---------- Calendário estrutural ----------
{
  assert.strictEqual(thirdFriday(2026, 11), '2026-11-20');
  assert.strictEqual(thirdFriday(2026, 12), '2026-12-18');
  assert.strictEqual(thirdFriday(2027, 1), '2027-01-15');
  assert.strictEqual(lastWeekday(2026, 11), '2026-11-30');
  assert.strictEqual(lastWeekday(2026, 8), '2026-08-31');
  assert.strictEqual(lastWeekday(2026, 5), '2026-05-29'); // 31/05 é domingo
  const ev = structural(Date.parse('2026-11-09T20:00:00Z'));
  const has = (date, kind, txt) => ev.some((e) => e.date === date && e.kind === kind && (!txt || e.label.includes(txt)));
  assert(has('2026-11-18', 'vix'), 'vencimento do VIX (quarta) em 18/11');
  assert.strictEqual(new Date('2026-11-18T12:00:00Z').getUTCDay(), 3);
  assert(has('2026-11-20', 'opex', 'mensal'));
  assert(has('2026-11-26', 'holiday'));
  assert(has('2026-11-27', 'early'));
  assert(has('2026-11-30', 'monthend', 'Fim de mês'));
  assert(has('2026-12-09', 'fomc'));
  assert(has('2026-12-10', 'roll'), 'rolagem 8 dias antes do vencimento trimestral');
  assert(has('2026-12-18', 'opex', 'trimestral'));
  assert(has('2026-12-24', 'early'));
  assert(has('2026-12-25', 'holiday'));
  assert(has('2026-12-31', 'monthend', 'Fim de trimestre'));
  assert(!ev.some((e) => e.date < '2026-11-09'), 'nada no passado');
  assert(ev.every((e) => e.inDays >= 0 && e.inDays <= 60));
  for (let i = 1; i < ev.length; i++) assert(ev[i - 1].date <= ev[i].date, 'ordenado');
  assert.strictEqual(ev.filter((e) => e.kind === 'opex' && e.date === '2026-11-20').length, 1, 'sem duplicatas');
  const today = structural(Date.parse('2026-11-20T15:00:00Z'));
  assert.strictEqual(today[0].inDays, 0, 'evento de hoje aparece com inDays 0');
  console.log('estrutura-> ', ev.length, 'eventos em 60 dias; próximo:', ev[0].date, ev[0].label);
}
console.log('\nTestes dos módulos passaram.');
