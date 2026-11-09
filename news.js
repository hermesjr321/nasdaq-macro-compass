'use strict';
/*
 * Notícias globais: busca manchetes no Google News RSS e classifica por palavras-chave.
 * A classificação mede RELEVÂNCIA (pode mudar a trajetória do dia ou da semana), não direção.
 * Palavras-chave não entendem contexto: trate como radar, não como veredito.
 */

const QUERIES = [
  'Federal Reserve OR FOMC OR Powell OR "Treasury yields"',
  'stock market OR Nasdaq OR "Wall Street" futures',
  'tariffs OR "trade war" OR sanctions OR "export controls"',
  'war OR ceasefire OR missile OR geopolitics markets',
  '"oil prices" OR OPEC OR crude',
  'jobs report OR CPI OR inflation OR payrolls',
  'Nvidia OR OpenAI OR "AI chips" OR "big tech" earnings',
  'election OR "White House" OR Congress OR "government shutdown" markets',
];

const CATS = [
  { id: 'fed', label: 'Fed / juros', w: 3, h: 'semana', res: [/\b(Fed|FOMC|Powell|Federal Reserve)\b/, /\b(rate (cut|hike)s?|interest rates?|(Treasury|bond) yields?)\b/i] },
  { id: 'dados', label: 'Inflação / emprego', w: 3, h: 'dia', res: [/\b(cpi|inflation|payrolls?|jobs report|unemployment|pce|ppi|jobless claims|nonfarm)\b/i] },
  { id: 'tarifas', label: 'Tarifas / comércio', w: 3, h: 'semana', res: [/\b(tariffs?|trade war|trade deal|sanctions?|export controls?|chip ban|embargo)\b/i] },
  { id: 'geo', label: 'Geopolítica', w: 3, h: 'semana', res: [/\b(war|missiles?|airstrikes?|ceasefire|iran|israel|russia|ukraine|taiwan|north korea|invasion|hormuz|gaza)\b/i] },
  { id: 'energia', label: 'Energia', w: 2, h: 'dia', res: [/\b(opec|oil prices?|crude|brent|natural gas)\b/i] },
  { id: 'tech', label: 'Big tech / IA', w: 2, h: 'dia', res: [/\b(nvidia|openai|ai chips?|semiconductors?|apple|microsoft|alphabet|google|amazon|tesla|earnings|guidance)\b/i, /\bMeta\b/] },
  { id: 'sistemico', label: 'Crédito / sistêmico', w: 3, h: 'semana', res: [/\b(bank failure|default|downgrade|shutdown|debt ceiling|credit crunch|liquidity crisis|bailout|treasury auction)\b/i] },
  { id: 'politica', label: 'Política EUA', w: 2, h: 'semana', res: [/\b(election|midterms?|congress|white house|executive order|supreme court|senate)\b/i, /\bTrump\b/] },
];
const BOOST = /\b(plunge[sd]?|crash(es|ed)?|sell-?off|surge[sd]?|soar[sd]?|tumble[sd]?|record high|halt(ed)?|emergency|panic|shock|stuns?|surprise)\b/i;
const FLAG_AT = 5;
// Palavras que indicam algo súbito ou fora do esperado (o "vermelho" estilo Financial Juice).
const SURPRISE = /\b(unexpected(ly)?|surprise[sd]?|sudden(ly)?|shock(s|ed|ing)?|stuns?|emergency|breaking|abrupt(ly)?|snap(s|ped)|halts?|suspends?|resigns?|ousted|attack(s|ed)?|invad(e|es|ed)|collapse[sd]?|crash(es|ed)?|plunge[sd]?|plummet(s|ed)?|tumble[sd]?|soar(s|ed)?|surge[sd]?|defaults?|bankrupt(cy)?|explosions?|blasts?|retaliat(e|es|ed|ion)|escalat(e|es|ed|ion))\b/i;

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENT[m] || m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/<[^>]+>/g, '')
    .trim();
const tag = (b, n) => {
  const m = b.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`));
  return m ? decode(m[1]) : '';
};

function parseRss(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    let title = tag(b, 'title');
    let source = tag(b, 'source');
    const link = tag(b, 'link');
    const t = Date.parse(tag(b, 'pubDate'));
    const i = title.lastIndexOf(' - ');
    if (i > 20) {
      if (!source) source = title.slice(i + 3);
      title = title.slice(0, i);
    }
    if (title && isFinite(t) && /^https?:\/\//i.test(link)) items.push({ title, source, link, time: t });
  }
  return items;
}

function classify(item, now = Date.now()) {
  const cats = CATS.filter((c) => c.res.some((r) => r.test(item.title)));
  let score = cats.reduce((s, c) => s + c.w, 0);
  const boosted = BOOST.test(item.title);
  if (boosted) score += 1;
  const ageH = (now - item.time) / 3600e3;
  score += ageH < 3 ? 2 : ageH < 12 ? 1 : ageH > 48 ? -2 : 0;
  const horizon = cats.some((c) => c.h === 'semana') ? 'semana' : cats.length ? 'dia' : '';
  return { ...item, cats: cats.map((c) => ({ id: c.id, label: c.label })), score, horizon, flagged: score >= FLAG_AT && cats.length > 0, boosted, surprise: SURPRISE.test(item.title), ageH };
}

async function fetchNews(getText, now = Date.now()) {
  const results = await Promise.allSettled(
    QUERIES.map((q) =>
      getText(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:2d')}&hl=en-US&gl=US&ceid=US:en`, 10000)
    )
  );
  const seen = new Set();
  const out = [];
  let okCount = 0;
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    okCount++;
    for (const it of parseRss(r.value)) {
      if (now - it.time > 72 * 3600e3) continue;
      const key = it.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 70);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(classify(it, now));
    }
  }
  out.sort((a, b) => Number(b.flagged) - Number(a.flagged) || b.score - a.score || b.time - a.time);
  return { items: out, okCount, total: QUERIES.length };
}

module.exports = { fetchNews, parseRss, classify, CATS };
