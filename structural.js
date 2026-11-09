'use strict';
/*
 * Eventos estruturais calculados por regra de data (não dependem de feed):
 * vencimentos de opções, rolagem de contratos, fim de mês/trimestre, reuniões do FOMC e feriados da NYSE.
 *
 * Limites: feriados e reuniões do FOMC abaixo são listas fixas, válidas até fev/2027. Confira no calendário da NYSE
 * e do Fed antes de operar e atualize a lista uma vez por ano. Leilões do Tesouro ficaram de fora porque não têm
 * regra fixa de data. Datas de payroll, CPI e PPI já vêm do calendário econômico, não daqui.
 */

const { etClock, addDay } = require('./levels');

// Dia da decisão (2º dia da reunião) do FOMC em 2026
const FOMC_2026 = ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09'];
// Feriados (mercado fechado) e meio-período (fecha 13h ET) da NYSE
const HOLIDAYS = [
  ['2026-11-26', 'Feriado nos EUA: Ação de Graças (mercado fechado)'],
  ['2026-12-25', 'Feriado nos EUA: Natal (mercado fechado)'],
  ['2027-01-01', 'Feriado nos EUA: Ano Novo (mercado fechado)'],
  ['2027-01-18', 'Feriado nos EUA: Martin Luther King (mercado fechado)'],
  ['2027-02-15', 'Feriado nos EUA: Presidents Day (mercado fechado)'],
];
const EARLY = [
  ['2026-11-27', 'Pregão encurtado nos EUA (fecha 13h ET), dia seguinte à Ação de Graças'],
  ['2026-12-24', 'Pregão encurtado nos EUA (fecha 13h ET), véspera de Natal'],
];

const dow = (ds) => new Date(ds + 'T12:00:00Z').getUTCDay(); // 0 domingo
const pad = (n) => String(n).padStart(2, '0');

function thirdFriday(y, m) { // m = 1..12
  const first = `${y}-${pad(m)}-01`;
  const off = (5 - dow(first) + 7) % 7;
  return `${y}-${pad(m)}-${pad(1 + off + 14)}`;
}
function lastWeekday(y, m) {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let ds = `${y}-${pad(m)}-${pad(last)}`;
  while (dow(ds) === 0 || dow(ds) === 6) ds = addDay(ds, -1);
  return ds;
}
const diffDays = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400e3);

function structural(nowMs, windowDays = 60) {
  const today = etClock(nowMs).date;
  const [cy, cm] = today.split('-').map(Number);
  const out = [];
  const push = (date, kind, label, note) => {
    const inDays = diffDays(today, date);
    if (inDays >= 0 && inDays <= windowDays) out.push({ date, inDays, kind, label, note });
  };
  for (let k = 0; k < 4; k++) {
    const y = cy + Math.floor((cm - 1 + k) / 12);
    const m = ((cm - 1 + k) % 12) + 1;
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    const tf = thirdFriday(y, m);
    const quarterly = m % 3 === 0;
    push(
      tf, 'opex',
      quarterly ? 'Vencimento trimestral (opções e futuros de índice)' : 'Vencimento mensal de opções',
      quarterly ? 'Costuma elevar volume e volatilidade perto do fechamento; o contrato trimestral dos futuros vence.' : 'Fluxo de hedge das opções costuma elevar o volume perto do fechamento.'
    );
    if (quarterly) push(addDay(tf, -8), 'roll', 'Rolagem dos futuros (contrato do trimestre)', 'O volume migra para o próximo contrato; confira qual contrato seu gráfico usa.');
    // Vencimento do VIX: quarta-feira 30 dias antes da 3ª sexta do mês seguinte
    push(addDay(thirdFriday(ny, nm), -30), 'vix', 'Vencimento dos futuros e opções do VIX', 'Pode mexer no VIX sem relação com o preço do índice.');
    const lw = lastWeekday(y, m);
    push(lw, 'monthend', quarterly ? 'Fim de trimestre (rebalanceamento de carteiras)' : 'Fim de mês (rebalanceamento de carteiras)', 'Fluxo de rebalanceamento pode distorcer o fim do pregão.');
  }
  for (const d of FOMC_2026) push(d, 'fomc', 'Decisão do FOMC (juros e coletiva)', 'Um dos eventos de maior impacto do mês; o painel também lista no calendário quando o feed trouxer.');
  for (const [d, t] of HOLIDAYS) push(d, 'holiday', t, 'Volume baixo e movimentos fora do normal no entorno.');
  for (const [d, t] of EARLY) push(d, 'early', t, 'Liquidez menor na parte final do dia.');
  out.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
  return out;
}

module.exports = { structural, thirdFriday, lastWeekday };
