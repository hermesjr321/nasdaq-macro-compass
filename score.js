'use strict';
/*
 * Motor de score do Nasdaq Macro Compass v2.
 * Entrada: cotações (Q), eventos do calendário e "agora". Saída: score do DIA e da SEMANA,
 * blocos com contribuição, divergências, risco de evento e uma tese em texto.
 * Tudo automático: nenhum campo manual. Heurística transparente, não um modelo validado.
 *
 * Horizonte: o contexto do dia usa a variação do dia inteiro (Ásia + Europa + futuros),
 * não a abertura de NY. O contexto da semana usa 5 sessões, média de 20 e 50.
 */

const clamp = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));
const avg = (a) => {
  const v = a.filter((x) => x != null && isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};
const sc = (x, s) => (x == null || !isFinite(x) ? null : clamp(x / s));
const get = (Q, s) => (Q && Q[s] && Q[s].ok ? Q[s] : null);
const pick = (Q, ...ss) => {
  for (const s of ss) {
    const q = get(Q, s);
    if (q) return q;
  }
  return null;
};
const rel = (a, b, k) => (a && b && a[k] != null && b[k] != null ? a[k] - b[k] : null);
const grp = (Q, ss, k) => avg(ss.map((s) => { const q = get(Q, s); return q ? q[k] : null; }));
const f = (x, d = 2) => (x == null || !isFinite(x) ? 'n/d' : (x > 0 ? '+' : '') + x.toFixed(d) + '%');
const sg = (n) => (n > 0 ? '+' : '') + n;
// Yahoo às vezes devolve ^TNX como yield x10; converte a diferença absoluta em pontos-base
const bp = (q, key) => (q && q[key] != null ? q[key] * (q.price > 20 ? 10 : 100) : null);
const bpTxt = (x) => (x == null ? 'n/d' : (x > 0 ? '+' : '') + x.toFixed(1) + ' bp');

function buildBlocks(Q) {
  const out = [];
  const add = (id, name, weight, day, week, notes) =>
    out.push({
      id, name, weight,
      day: day == null ? null : +day.toFixed(3),
      week: week == null ? null : +week.toFixed(3),
      notes: notes.filter(Boolean),
    });

  const nq = pick(Q, 'NQ=F', 'QQQ');
  const vix = get(Q, '^VIX');

  // 1. Tendência do Nasdaq (20)
  if (nq) {
    const day = sc(nq.chg1d, 1.2);
    const wk =
      0.5 * (sc(nq.chg5d, 3) ?? 0) +
      0.25 * (nq.a20 == null ? 0 : nq.a20 ? 1 : -1) +
      0.25 * (nq.a50 == null ? 0 : nq.a50 ? 1 : -1);
    add('trend', 'Tendência do Nasdaq', 20, day, wk, [
      `NQ ${f(nq.chg1d)} no dia, ${f(nq.chg5d)} em 5 sessões, ${f(nq.chg20d)} em 20.`,
      `Preço ${nq.a20 ? 'acima' : 'abaixo'} da média de 20 dias e ${nq.a50 ? 'acima' : 'abaixo'} da de 50.`,
    ]);
  } else add('trend', 'Tendência do Nasdaq', 20, null, null, []);

  // 2. Confirmação de índices e amplitude (15)
  {
    const es = get(Q, 'ES=F'), ym = get(Q, 'YM=F'), rty = get(Q, 'RTY=F');
    const rsp = get(Q, 'RSP'), spy = get(Q, 'SPY'), qqqe = get(Q, 'QQQE'), qqq = get(Q, 'QQQ');
    const d = [
      es && sc(es.chg1d, 1), ym && sc(ym.chg1d, 1), rty && sc(rty.chg1d, 1.3),
      sc(rel(rsp, spy, 'chg1d'), 0.5), sc(rel(qqqe, qqq, 'chg1d'), 0.5),
    ];
    const w = [
      es && sc(es.chg5d, 2.5), ym && sc(ym.chg5d, 2.5), rty && sc(rty.chg5d, 3.5),
      sc(rel(rsp, spy, 'chg5d'), 1.2), sc(rel(qqqe, qqq, 'chg5d'), 1.2),
    ];
    add('breadth', 'Confirmação e amplitude', 15, avg(d), avg(w), [
      `ES ${f(es?.chg1d)} · YM ${f(ym?.chg1d)} · RTY ${f(rty?.chg1d)} no dia.`,
      rsp && spy ? `S&P equal-weight vs cap-weight: ${f(rel(rsp, spy, 'chg1d'))} no dia (positivo = amplitude saudável).` : null,
    ]);
  }

  // 3. Rotação setorial (10)
  {
    const cyc = ['XLK', 'XLY', 'XLF', 'XLI', 'XLC'], def = ['XLV', 'XLU', 'XLP'];
    const c1 = grp(Q, cyc, 'chg1d'), d1 = grp(Q, def, 'chg1d');
    const c5 = grp(Q, cyc, 'chg5d'), d5 = grp(Q, def, 'chg5d');
    const diff1 = c1 != null && d1 != null ? c1 - d1 : null;
    const diff5 = c5 != null && d5 != null ? c5 - d5 : null;
    add('sectors', 'Rotação setorial', 10, sc(diff1, 0.8), sc(diff5, 2), [
      `Cíclicos ${f(c1)} vs defensivos ${f(d1)} no dia; em 5 sessões ${f(c5)} vs ${f(d5)}.`,
    ]);
  }

  // 4. Estilo e apetite por risco (10)
  {
    const P = [
      ['IWF', 'IWD', 'Growth/Value', 0.6, 1.5],
      ['SPHB', 'SPLV', 'High Beta/Low Vol', 0.8, 2],
      ['ARKK', 'SPY', 'Especulativos/S&P', 0.9, 2.5],
      ['SMH', 'SPY', 'Semis/S&P', 0.7, 2],
    ];
    const d = [], w = [], notes = [];
    for (const [a, b, n, s1, s5] of P) {
      const qa = get(Q, a), qb = get(Q, b);
      d.push(sc(rel(qa, qb, 'chg1d'), s1));
      w.push(sc(rel(qa, qb, 'chg5d'), s5));
      if (qa && qb) notes.push(`${n}: ${f(rel(qa, qb, 'chg1d'))} no dia, ${f(rel(qa, qb, 'chg5d'))} em 5 sessões (relativo).`);
    }
    add('style', 'Estilo e apetite por risco', 10, avg(d), avg(w), notes);
  }

  // 5. Volatilidade e proteção (15)
  {
    const v3 = get(Q, '^VIX3M'), skew = get(Q, '^SKEW'), vvix = get(Q, '^VVIX');
    let lvl = null, ts = null, skS = null, vvS = null;
    if (vix) {
      const p = vix.price;
      lvl = p < 14 ? 0.6 : p < 17 ? 0.35 : p < 20 ? 0.1 : p < 24 ? -0.2 : p < 30 ? -0.6 : -1;
    }
    if (vix && v3) {
      const r = vix.price / v3.price;
      ts = r < 0.88 ? 0.5 : r < 0.95 ? 0.25 : r < 1 ? 0 : r < 1.08 ? -0.6 : -1;
    }
    if (skew) {
      const p = skew.price;
      skS = p >= 155 ? -0.7 : p >= 145 ? -0.35 : p >= 135 ? 0 : 0.3;
    }
    if (vvix) {
      const p = vvix.price;
      vvS = p > 120 ? -0.5 : p > 105 ? -0.15 : 0.2;
    }
    const vd = vix ? avg([lvl, sc(-vix.chg1d, 6)]) : null;
    const vw = vix ? avg([lvl, sc(-vix.chg5d, 15)]) : null;
    add('vol', 'Volatilidade e proteção', 15, avg([vd, ts, skS, vvS]), avg([vw, ts, skS, vvS]), [
      vix ? `VIX ${vix.price.toFixed(1)} (${f(vix.chg1d)} no dia, ${f(vix.chg5d)} em 5 sessões).` : null,
      vix && v3 ? `Estrutura a termo VIX/VIX3M = ${(vix.price / v3.price).toFixed(2)} (acima de 1 indica estresse de curto prazo).` : null,
      skew ? `SKEW ${skew.price.toFixed(0)} (alto = mais demanda por proteção contra cauda).` : null,
      vvix ? `VVIX ${vvix.price.toFixed(0)}.` : null,
    ]);
  }

  // 6. Juros, dólar e iene (15)
  {
    const tnx = get(Q, '^TNX'), dxy = get(Q, 'DX-Y.NYB'), jpy = get(Q, 'USDJPY=X');
    const b1 = bp(tnx, 'abs1d'), b5 = bp(tnx, 'abs5d');
    let rd = sc(b1 == null ? null : -b1, 8);
    let rw = sc(b5 == null ? null : -b5, 20);
    // Juros subindo com ações subindo e VIX caindo = crescimento, não pressão sobre valuation
    let damped = false;
    if (rd != null && b1 > 0 && nq && nq.chg1d > 0.3 && vix && vix.chg1d < 0) { rd *= 0.3; damped = true; }
    if (rw != null && b5 > 0 && nq && nq.chg5d > 0.5 && vix && vix.chg5d < 0) { rw *= 0.3; damped = true; }
    const jd = jpy && sc(jpy.chg1d, 1.2) != null ? sc(jpy.chg1d, 1.2) * 0.6 : null;
    const jw = jpy && sc(jpy.chg5d, 2.5) != null ? sc(jpy.chg5d, 2.5) * 0.6 : null;
    add('ratesfx', 'Juros, dólar e iene', 15,
      avg([rd, sc(dxy ? -dxy.chg1d : null, 0.5), jd]),
      avg([rw, sc(dxy ? -dxy.chg5d : null, 1.2), jw]), [
        tnx ? `US10Y ${(tnx.price > 20 ? tnx.price / 10 : tnx.price).toFixed(2)}% (${bpTxt(b1)} no dia, ${bpTxt(b5)} em 5 sessões).` : null,
        damped ? 'Juros subindo com ações firmes e VIX caindo: leitura de crescimento, penalidade reduzida.' : null,
        dxy ? `DXY ${f(dxy.chg1d)} no dia, ${f(dxy.chg5d)} em 5 sessões (dólar forte pesa em tecnologia).` : null,
        jpy ? `USD/JPY ${f(jpy.chg1d)} no dia (queda forte do par sugere desmonte de carry).` : null,
      ]);
  }

  // 7. Crédito (5)
  {
    const hyg = get(Q, 'HYG'), lqd = get(Q, 'LQD');
    add('credit', 'Crédito', 5,
      hyg ? avg([sc(rel(hyg, lqd, 'chg1d'), 0.3), sc(hyg.chg1d, 0.3)]) : null,
      hyg ? avg([sc(rel(hyg, lqd, 'chg5d'), 0.8), hyg.a20 == null ? null : hyg.a20 ? 0.4 : -0.4]) : null,
      [hyg ? `High yield (HYG) ${f(hyg.chg1d)} no dia; ${lqd ? 'grau de investimento (LQD) ' + f(lqd.chg1d) : ''}. Crédito fraco costuma avisar antes das ações.` : null]);
  }

  // 8. Sessões globais já fechadas (5)
  {
    const S = ['^N225', '^GDAXI', '^HSI'];
    const a1 = grp(Q, S, 'chg1d'), a5 = grp(Q, S, 'chg5d');
    add('global', 'Bolsas globais (Ásia/Europa)', 5, sc(a1, 1.2), sc(a5, 3), [
      `Nikkei ${f(get(Q, '^N225')?.chg1d)} · DAX ${f(get(Q, '^GDAXI')?.chg1d)} · Hang Seng ${f(get(Q, '^HSI')?.chg1d)} no dia.`,
    ]);
  }

  // 9. Commodities e risco 24h (5)
  {
    const cu = get(Q, 'HG=F'), oil = get(Q, 'CL=F'), gold = get(Q, 'GC=F'), btc = get(Q, 'BTC-USD');
    const d = [
      sc(cu?.chg1d, 1.5),
      oil ? sc(-oil.chg1d, 3) * 0.5 : null,
      gold ? sc(-gold.chg1d, 1.5) * 0.4 : null,
      btc ? sc(btc.chg1d, 3) * 0.5 : null,
    ];
    const w = [
      sc(cu?.chg5d, 4),
      oil ? sc(-oil.chg5d, 7) * 0.5 : null,
      gold ? sc(-gold.chg5d, 3.5) * 0.4 : null,
      btc ? sc(btc.chg5d, 8) * 0.5 : null,
    ];
    add('commod', 'Commodities e cripto (risco 24h)', 5, avg(d), avg(w), [
      `Cobre ${f(cu?.chg1d)} · petróleo ${f(oil?.chg1d)} · ouro ${f(gold?.chg1d)} · bitcoin ${f(btc?.chg1d)} no dia.`,
      'Cobre e bitcoin sobem com apetite por risco; petróleo e ouro em alta forte pesam como inflação/proteção.',
    ]);
  }
  return out;
}

function aggregate(blocks, key) {
  let ws = 0, tot = 0, avail = 0;
  for (const b of blocks) {
    tot += b.weight;
    if (b[key] != null) { ws += b[key] * b.weight; avail += b.weight; }
  }
  return { score: avail ? Math.round((ws / avail) * 100) : 0, coverage: tot ? Math.round((avail / tot) * 100) : 0 };
}

const labelOf = (s) =>
  s >= 60 ? 'COMPRADOR FORTE' : s >= 25 ? 'COMPRADOR MODERADO' : s <= -60 ? 'VENDEDOR FORTE' : s <= -25 ? 'VENDEDOR MODERADO' : 'NEUTRO / SEM VANTAGEM';

function eventRisk(events, now) {
  const H = 3600e3;
  const hi = (events || []).filter((e) => e.impact === 'High').sort((a, b) => a.time - b.time);
  const usd = hi.filter((e) => e.currency === 'USD' && e.time >= now - H);
  const next = usd[0] || null;
  const hoursUntil = next ? (next.time - now) / H : null;
  let level = 'baixo';
  if (next && hoursUntil <= 3) level = 'extremo';
  else if (next && hoursUntil <= 24) level = 'alto';
  else if (usd.some((e) => e.time - now <= 7 * 24 * H)) level = 'moderado';
  if (level === 'baixo') {
    const o = hi.find((e) => e.currency !== 'USD' && e.time >= now - H && (e.time - now) / H <= 6);
    if (o) level = 'moderado';
  }
  return { level, next, hoursUntil, weekCountUSD: usd.filter((e) => e.time - now <= 7 * 24 * H).length };
}

function confidenceOf(blocks, key, agg, risk) {
  const sign = Math.sign(agg.score);
  const act = blocks.filter((b) => b[key] != null && Math.abs(b[key]) >= 0.1);
  const alignment = act.length ? (sign === 0 ? 0.5 : act.filter((b) => Math.sign(b[key]) === sign).length / act.length) : 0;
  const pen = { extremo: 0.4, alto: 0.25, moderado: 0.1, baixo: 0 }[risk.level];
  const c = Math.round((agg.coverage / 100 * 0.5 + alignment * 0.5) * (1 - pen) * 100);
  return { confidence: c, confLabel: c < 40 ? 'baixa' : c < 65 ? 'média' : 'alta', alignment: Math.round(alignment * 100) };
}

function detectFlags(Q) {
  const fl = [];
  const nq = pick(Q, 'NQ=F', 'QQQ'), vix = get(Q, '^VIX'), rty = get(Q, 'RTY=F'), hyg = get(Q, 'HYG');
  const tnx = get(Q, '^TNX'), dxy = get(Q, 'DX-Y.NYB'), jpy = get(Q, 'USDJPY=X'), oil = get(Q, 'CL=F');
  if (nq && vix) {
    if (nq.chg1d > 0.5 && vix.chg1d > 3) fl.push('Nasdaq sobe mas o VIX também sobe: alguém está comprando proteção. Desconfie da alta.');
    if (nq.chg1d < -0.5 && vix.chg1d < -2) fl.push('Nasdaq cai com o VIX caindo: queda sem pânico, pode ser rotação em vez de aversão a risco.');
  }
  if (nq && rty && nq.chg1d > 0.5 && rty.chg1d < -0.5) fl.push('Nasdaq sobe sozinho enquanto o Russell cai: amplitude fraca.');
  if (nq && hyg && nq.chg1d > 0.5 && hyg.chg1d < -0.3) fl.push('Crédito high yield cai enquanto o Nasdaq sobe: o crédito não confirma.');
  const b1 = bp(tnx, 'abs1d');
  if (b1 != null && b1 >= 10) fl.push(`Juros de 10 anos subindo forte (${bpTxt(b1)}): pressão sobre valuation de tecnologia.`);
  if (dxy && dxy.chg1d >= 0.7) fl.push(`Dólar forte no dia (${f(dxy.chg1d)}): vento contra para ativos de risco.`);
  if (jpy && jpy.chg1d <= -1.2) fl.push(`Iene se fortalecendo forte (USD/JPY ${f(jpy.chg1d)}): risco de desmonte de carry trade.`);
  if (oil && Math.abs(oil.chg1d) >= 4) fl.push(`Petróleo com movimento extremo (${f(oil.chg1d)}): choque de energia/inflação em jogo.`);
  if (vix && (vix.price >= 25 || vix.chg1d >= 12)) fl.push(`Volatilidade elevada (VIX ${vix.price.toFixed(1)}, ${f(vix.chg1d)} no dia): regime de estresse.`);
  return fl;
}

function hoursText(h) {
  const m = Math.round(Math.abs(h) * 60);
  const t = m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'min' : ''}` : `${m}min`;
  return h >= 0 ? `em ${t}` : `há ${t}`;
}

function narrative(day, week, blocks, risk) {
  const L = [];
  const dirD = Math.sign(day.score);
  const sorted = (key) => [...blocks].filter((b) => b[key] != null).sort((a, b) => Math.abs(b[key] * b.weight) - Math.abs(a[key] * a.weight));
  const names = (arr) => arr.slice(0, 2).map((b) => b.name.toLowerCase()).join(' e ');
  const pro = sorted('day').filter((b) => (dirD >= 0 ? b.day > 0.15 : b.day < -0.15));
  const con = sorted('day').filter((b) => (dirD >= 0 ? b.day < -0.15 : b.day > 0.15));
  L.push(
    `Dia: ${day.label.toLowerCase()} (${sg(day.score)}). ` +
      `${pro.length ? 'Sustentam: ' + names(pro) + '. ' : ''}` +
      `${con.length ? 'Contra: ' + names(con) + '.' : 'Nenhum bloco relevante contra.'}`
  );
  const same = Math.sign(day.score) === Math.sign(week.score) || Math.abs(day.score) < 15 || Math.abs(week.score) < 15;
  L.push(
    `Semana: ${week.label.toLowerCase()} (${sg(week.score)}). ` +
      (same ? 'Dia e semana não se contradizem.' : 'Dia e semana divergem: o movimento de hoje vai contra a tendência de 5 a 20 sessões, o que reduz a convicção.')
  );
  if (risk.next) {
    L.push(`Evento: ${risk.next.title} (${risk.next.currency}) ${hoursText(risk.hoursUntil)}. Risco de evento ${risk.level}${risk.weekCountUSD > 1 ? `; ${risk.weekCountUSD} red folders dos EUA nos próximos 7 dias` : ''}.`);
  } else {
    L.push('Nenhum red folder dos EUA encontrado nos próximos 7 dias (confira a fonte do calendário).');
  }
  return L;
}

function regimeOf(day, Q) {
  const vix = get(Q, '^VIX');
  if (vix && vix.price >= 25) return 'Risk Off';
  if (day.score >= 25 && (!vix || vix.price < 20)) return 'Risk On';
  if (day.score <= -25) return 'Risk Off';
  return 'Misto / transição';
}

function computeAll(Q, events, now = Date.now()) {
  const blocks = buildBlocks(Q);
  const risk = eventRisk(events, now);
  const mk = (key) => {
    const a = aggregate(blocks, key);
    return { ...a, label: a.coverage < 40 ? 'DADOS INSUFICIENTES' : labelOf(a.score), insufficient: a.coverage < 40, ...confidenceOf(blocks, key, a, risk) };
  };
  const day = mk('day'), week = mk('week');
  return { day, week, blocks, risk, flags: detectFlags(Q), regime: regimeOf(day, Q), narrative: narrative(day, week, blocks, risk) };
}

module.exports = { computeAll, buildBlocks, aggregate, eventRisk, labelOf, detectFlags };
