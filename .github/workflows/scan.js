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

// 3+ taps with 6+ candle spacing (Tori's core rule)
function findValidTaps(points, minSpacing=6, minTaps=3) {
  const taps = [];
  for (let i = points.length-1; i >= 0; i--) {
    if (taps.length === 0) {
      taps.unshift(points[i]);
    } else {
      const gap = taps[0].i - points[i].i;
      if (gap >= minSpacing) taps.unshift(points[i]);
    }
    if (taps.length >= minTaps) break;
  }
  return taps.length >= minTaps ? taps : null;
}

function slopeOk(slope, lastATR) {
  const abs = Math.abs(slope);
  return abs > lastATR * 0.03 && abs < lastATR * 0.5;
}

// One trade per trendline — check for prior break in last 20 candles
function priorBreakExists(candles, trendline, trend) {
  const checkFrom = Math.max(0, candles.length - 25);
  const checkTo = candles.length - 2;
  let crossings = 0;
  for (let i = checkFrom; i <= checkTo; i++) {
    const lineVal = trendline.slope*i + trendline.intercept;
    const wasBeyond = trend==='up' ? candles[i].c > lineVal : candles[i].c < lineVal;
    if (wasBeyond) crossings++;
  }
  return crossings > 3;
}

function analyze(symbol, candles) {
  if (candles.length < 90) return null;

  const atrSeries = atr(candles, 14);
  const lastATR = atrSeries[atrSeries.length-1];
  const {highs, lows} = findPivots(candles, 3);

  // Step 1: Trend
  let trend = null;
  if (highs.length>=2 && lows.length>=2) {
    const h1=highs[highs.length-2], h2=highs[highs.length-1];
    const l1=lows[lows.length-2], l2=lows[lows.length-1];
    if (h2.price>h1.price && l2.price>l1.price) trend='up';
    else if (h2.price<h1.price && l2.price<l1.price) trend='down';
  }
  if (!trend) return null;

  // Step 2: 3+ taps, 6+ candle spacing, 3+ weeks
  const H4_PER_WEEK = 30;
  const swingPool = trend==='up' ? lows : highs;
  const taps = findValidTaps(swingPool, 6, 3);
  if (!taps) return null;

  const spanCandles = taps[taps.length-1].i - taps[0].i;
  if (spanCandles < 3 * H4_PER_WEEK) return null;

  const trendline = linReg(taps);
  if (!slopeOk(Math.abs(trendline.slope), lastATR)) return null;

  // Step 3: One trade per trendline
  if (priorBreakExists(candles, trendline, trend)) return null;

  // Step 4: Compression
  const lastIdx = candles.length-1;
  const lineVal = trendline.slope*lastIdx + trendline.intercept;
  const distToLine = Math.abs(candles[lastIdx].c - lineVal);
  const atrRecent = atrSeries.slice(-5).reduce((a,b)=>a+b,0)/5;
  const atrPrior = atrSeries.slice(-20,-5).reduce((a,b)=>a+b,0)/15;
  if (atrRecent >= atrPrior*0.92 || distToLine >= lastATR*0.8) return null;

  // Step 5: Break confirmation
  const last = candles[candles.length-1];
  const lineValLast = trendline.slope*(candles.length-1) + trendline.intercept;
  const body = Math.abs(last.c - last.o);
  const range = last.h - last.l || 1e-9;
  const beyond = trend==='up' ? last.c > lineValLast : last.c < lineValLast;
  if (!beyond || body/range <= 0.55) return null;

  // Step 6: Safety line + stop at 4th candle projection
  const entry = last.c;
  const opposingPool = trend==='up' ? highs : lows;
  const opposingTaps = findValidTaps(opposingPool, 4, 2) || opposingPool.slice(-2);
  const safetyLine = opposingTaps && opposingTaps.length >= 2 ? linReg(opposingTaps) : null;

  let stop;
  if (safetyLine) {
    const stopIdx = lastIdx + 4;
    const safetyAtStop = safetyLine.slope*stopIdx + safetyLine.intercept;
    const stopValid = trend==='up' ? safetyAtStop < entry : safetyAtStop > entry;
    stop = stopValid ? safetyAtStop : (trend==='up'
      ? lineValLast - lastATR*0.5
      : lineValLast + lastATR*0.5);
  } else {
    stop = trend==='up' ? lineValLast - lastATR*0.5 : lineValLast + lastATR*0.5;
  }

  const riskDist = Math.abs(entry-stop);
  const target = trend==='up' ? entry + riskDist*2.5 : entry - riskDist*2.5;
  const rMultiple = 2.5;
  if (riskDist === 0) return null;

  const dec = symbol.includes('JPY') ? 3 : 5;
  return {
    direction: trend==='up' ? 'Long' : 'Short',
    entry: entry.toFixed(dec),
    stop: stop.toFixed(dec),
    target: target.toFixed(dec),
    taps: taps.length,
    spanWeeks: (spanCandles / H4_PER_WEEK).toFixed(1),
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
    console.log('No signals — all 8 Tori Trades rules checked. No notification sent.');
    return;
  }

  const title = `📈 ${signals.length} A+ signal${signals.length>1?'s':''} — Spiraled H4`;
  const message = signals.map(s =>
    `${s.symbol} — ${s.direction}\n` +
    `${s.taps} taps over ${s.spanWeeks}wks\n` +
    `Entry: ${s.entry} | Stop: ${s.stop} | Target: ${s.target}\n` +
    `R potential: ${s.rMultiple}R\n` +
    `⚠️ Check news + verify chart before entering`
  ).join('\n\n');

  await notify(title, message);
  console.log('Notification sent for:', signals.map(s=>s.symbol).join(', '));
}

main();
