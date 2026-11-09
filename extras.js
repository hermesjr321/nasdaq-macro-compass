'use strict';
/*
 * Blocos de contexto que vêm só das cotações: quem puxa o Nasdaq e juros/estresse.
 */

// Pesos APROXIMADOS das maiores ações do Nasdaq 100, em %. Mudam com o preço e na rebalanceamento do índice:
// ajuste aqui quando quiser. Servem só para estimar quem puxa o índice no dia.
const NDX_TOP = [
  ['NVDA', 9.0], ['MSFT', 8.5], ['AAPL', 8.0], ['AMZN', 5.5], ['AVGO', 5.0],
  ['GOOGL', 3.5], ['META', 3.5], ['TSLA', 3.0], ['NFLX', 2.5], ['COST', 2.5],
];

const ok = (q) => q && q.ok;

function movers(Q) {
  const rows = [];
  for (const [sym, w] of NDX_TOP) {
    const q = Q[sym];
    if (ok(q) && q.chg1d != null && isFinite(q.chg1d)) rows.push({ sym, w, chg: +q.chg1d.toFixed(2), contrib: +((w * q.chg1d) / 100).toFixed(3) });
  }
  if (rows.length < 5) return null;
  rows.sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib));
  const sum = rows.reduce((s, r) => s + r.contrib, 0);
  const wsum = rows.reduce((s, r) => s + r.w, 0);
  const idx = ok(Q['NQ=F']) ? Q['NQ=F'].chg1d : ok(Q.QQQ) ? Q.QQQ.chg1d : null;
  const share = idx != null && Math.abs(idx) >= 0.3 ? sum / idx : null; // fração do movimento do índice explicada pelo top 10
  return {
    rows, sum: +sum.toFixed(3), wsum, nq: idx == null ? null : +idx.toFixed(2),
    share: share == null ? null : +share.toFixed(2),
    up: rows.filter((r) => r.chg > 0).length, total: rows.length,
  };
}

// Yahoo às vezes entrega o rendimento multiplicado por 10 (formato antigo); a regra abaixo normaliza.
const yld = (q) => (ok(q) ? (q.price > 20 ? q.price / 10 : q.price) : null);
const dbp = (q) => (ok(q) && q.abs1d != null ? q.abs1d * (q.price > 20 ? 10 : 100) : null);

function ratesInfo(Q) {
  const t3m = Q['^IRX'], t5 = Q['^FVX'], t10 = Q['^TNX'], t30 = Q['^TYX'], mv = Q['^MOVE'];
  const y = (q) => (ok(q) ? { y: +yld(q).toFixed(3), d1: dbp(q) == null ? null : +dbp(q).toFixed(1) } : null);
  const out = { y3m: y(t3m), y5: y(t5), y10: y(t10), y30: y(t30) };
  const curve = (a, b) => {
    if (!out[a] || !out[b]) return null;
    const pp = out[b].y - out[a].y;
    const d1 = out[a].d1 != null && out[b].d1 != null ? +(out[b].d1 - out[a].d1).toFixed(1) : null;
    return { pp: +pp.toFixed(3), d1, label: pp < 0 ? 'invertida' : pp < 0.5 ? 'achatada' : 'positiva' };
  };
  out.c10_3m = curve('y3m', 'y10');
  out.c10_5 = curve('y5', 'y10');
  if (ok(mv)) {
    // Limiares aproximados: abaixo de 90 costuma ser calmo; acima de 120, estresse nos títulos.
    out.move = { price: +mv.price.toFixed(1), chg1d: mv.chg1d == null ? null : +mv.chg1d.toFixed(2), state: mv.price >= 120 ? 'estresse' : mv.price >= 90 ? 'atenção' : 'calmo' };
  } else out.move = null;
  const hyg = Q.HYG, lqd = Q.LQD;
  out.credit = ok(hyg) ? { hyg: hyg.chg1d == null ? null : +hyg.chg1d.toFixed(2), lqd: ok(lqd) && lqd.chg1d != null ? +lqd.chg1d.toFixed(2) : null } : null;
  const any = out.y3m || out.y5 || out.y10 || out.y30 || out.move || out.credit;
  return any ? out : null;
}

module.exports = { movers, ratesInfo, NDX_TOP };
