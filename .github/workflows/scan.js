const https = require('https');

const PAIRS = ["EUR/USD","GBP/USD","USD/JPY","EUR/JPY","GBP/JPY"];
const API_KEY = process.env.TWELVEDATA_KEY;
const NTFY_TOPIC = process.env.NTFY_TOPIC;

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function atr(candles, period) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i-1];
    trs.push(Math.max(c.h-c.l, Math.abs(c.h-p.c), Math.abs(c.l-p.c)));
  }
  const out = [];
  for (let i = 0; i < trs.length; i++) {
    const slice = trs.slice(Math.max(0, i-period+1), i+1);
    out.push(slice.reduce((a,b)=>a+b,0)/slice.length);
  }
  return out;
}

function findPivots(candles, lookback=3) {
  const highs=[], lows=[];
  for (let i=lookback; i<candles.length-lookback; i++) {
    const w = candles.slice(i-lookback, i+lookback+1);
    const c = candles[i];
    if (c.h === Math.max(...w.map(x=>x.h))) highs.push({i, price:c.h});
    if (c.l === Math.min(...w.map(x=>x.l))) lows.push({i, price:c.l});
  }
  return {highs, lows};
}

function linReg(points) {
  const n = points.length;
  const sumX = points.reduce((a,p)=>a+p.i,0);
  const sumY = points.reduce((a,p)=>a+p.price,0);
  const sumXY = points.reduce((a,p)=>a+p.i*p.price,0);
  const sumXX = points.reduce((a,p)=>a+p.i*p.i,0);
  const slope = (n*sumXY - sumX*sumY) / (n*sumXX - sumX*sumX || 1);
  const intercept = (sumY - slope*sumX) / n;
  return {slope, intercept};
}

function analyze(symbol, candles) {
  if (candles.length < 60) return null;
  const atrSeries = atr(candles, 14);
  const lastATR = atrSeries[atrSeries.length-1];
  const {highs, lows} = findPivots(candles, 3);

  let trend = null;
  if (highs.length>=2 && lows.length>=2) {
    const h1=highs[highs.length-2], h2=highs[highs.length-1];
    const l1=lows[lows.length-2], l2=lows[lows.length-1];
    if (h2.price>h1.price && l2.price>l1.price) trend='up';
    else if (h2.price<h1.price && l2.price<l1.price) trend='down';
  }
  if (!trend) return null;

  const swingSet = trend==='up' ? lows.slice(-3) : highs.slice(-3);
  if (swingSet.length < 2) return null;
  const trendline = linReg(swingSet);
  const perBarMove = Math.abs(trendline.slope);
  if (perBarMove < lastATR*0.04 || perBarMove > lastATR*0.9) return null;

  const lastIdx = candles.length-1;
  const lineVal = trendline.slope*lastIdx + trendline.intercept;
  const atrRecent = atrSeries.slice(-5).reduce((a,b)=>a+b,0)/5;
  const atrPrior = atrSeries.slice(-20,-5).reduce((a,b)=>a+b,0)/15;
  const distToLine = Math.abs(candles[lastIdx].c - lineVal);
  if (atrRecent >= atrPrior*0.92 || distToLine >= lastATR*0.8) return null;

  const last = candles[candles.length-1];
  const lineValLast = trendline.slope*(candles.length-1) + trendline.intercept;
  const body = Math.abs(last.c - last.o);
  const range = last.h - last.l || 1e-9;
  const beyond = trend==='up' ? last.c > lineValLast : last.c < lineValLast;
  if (!beyond || body/range <= 0.55) return null;

  const entry = last.c;
  const stop = trend==='up' ? lineValLast - lastATR*0.5 : lineValLast + lastATR*0.5;
  const riskDist = Math.abs(entry-stop);
  const target = trend==='up' ? entry + riskDist*2.5 : entry - riskDist*2.5;
  const rMultiple = 2.5;

  return {
    direction: trend==='up' ? 'Long' : 'Short',
    entry: entry.toFixed(symbol.includes('JPY') ? 3 : 5),
    stop: stop.toFixed(symbol.includes('JPY') ? 3 : 5),
    rMultiple
  };
}

function notify(title, message) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(message);
    const req = https.request({
      hostname: 'ntfy.sh',
      path: `/${NTFY_TOPIC}`,
      method: 'POST',
      headers: {
        'Title': title,
        'Content-Type': 'text/plain',
        'Content-Length': body.length,
        'Priority': 'high',
        'Tags': 'chart_with_upwards_trend'
      }
    }, resolve);
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const signals = [];

  for (const symbol of PAIRS) {
    try {
      const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=4h&outputsize=200&apikey=${API_KEY}`;
      const data = await get(url);
      if (data.status === 'error' || !data.values) { await sleep(900); continue; }

      const candles = data.values.map(v=>({
        t: new Date(v.datetime).getTime(),
        o: parseFloat(v.open), h: parseFloat(v.high),
        l: parseFloat(v.low), c: parseFloat(v.close)
      })).reverse();

      const result = analyze(symbol, candles);
      if (result) signals.push({symbol, ...result});
    } catch(e) {
      console.error(`Error for ${symbol}:`, e.message);
    }
    await sleep(900);
  }

  if (signals.length === 0) {
    console.log('No signals found. No notification sent.');
    return;
  }

  const title = `📈 ${signals.length} trade signal${signals.length>1?'s':''} — H4 Scanner`;
  const message = signals.map(s =>
    `${s.symbol} — ${s.direction}\nEntry: ${s.entry} | Stop: ${s.stop} | ${s.rMultiple}R potential\n⚠️ Verify chart + check news before entering`
  ).join('\n\n');

  await notify(title, message);
  console.log('Notification sent for:', signals.map(s=>s.symbol).join(', '));
}

main();
