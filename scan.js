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

function calcATR(candles, period) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i-1];
    trs.push(Math.max(c.h-c.l, Math.abs(c.h-p.c), Math.abs(c.l-p.c)));
  }
  const out = [];
  for (let i = 0; i < trs.length; i++) {
    const sl = trs.slice(Math.max(0, i-period+1), i+1);
    out.push(sl.reduce((a,b)=>a+b,0)/sl.length);
  }
  return out;
}

function findPivots(candles, lookback=3) {
  const highs=[], lows=[];
  for (let i=lookback; i<candles.length-lookback; i++) {
    const w = candles.slice(i-lookback, i+lookback+1), c = candles[i];
    if (c.h === Math.max(...w.map(x=>x.h))) highs.push({i, price:c.h});
    if (c.l === Math.min(...w.map(x=>x.l))) lows.push({i, price:c.l});
  }
  return {highs, lows};
}

function linReg(pts) {
  const n=pts.length;
  const sx=pts.reduce((a,p)=>a+p.i,0), sy=pts.reduce((a,p)=>a+p.price,0);
  const sxy=pts.reduce((a,p)=>a+p.i*p.price,0), sxx=pts.reduce((a,p)=>a+p.i*p.i,0);
  const slope=(n*sxy-sx*sy)/(n*sxx-sx*sx||1);
  return {slope, intercept:(sy-slope*sx)/n};
}

// 2–3 clean swing points (Tori Step 2: 2-3 taps)
function findValidTaps(pts, minSpacing=4, minTaps=2, maxTaps=3) {
  const taps=[];
  for (let i=pts.length-1; i>=0; i--) {
    if (taps.length===0) { taps.unshift(pts[i]); }
    else if (taps[0].i-pts[i].i >= minSpacing) { taps.unshift(pts[i]); }
    if (taps.length >= maxTaps) break;
  }
  return taps.length >= minTaps ? taps : null;
}

function slopeOk(slope, atr) {
  const a=Math.abs(slope);
  return a > atr*0.03 && a < atr*0.5;
}

// Step 2: max 1 prior failed break (2+ = no trade)
function countPriorBreaks(candles, tl, trend) {
  let breaks=0, wasBelow=false, init=false;
  const from=Math.max(0, candles.length-60);
  for (let i=from; i<candles.length-1; i++) {
    const lv=tl.slope*i+tl.intercept;
    const beyond = trend==='up' ? candles[i].c>lv : candles[i].c<lv;
    if (!init) { wasBelow=!beyond; init=true; continue; }
    if (beyond && wasBelow) { breaks++; wasBelow=false; }
    else if (!beyond) { wasBelow=true; }
  }
  return breaks;
}

// Step 1: check pullbacks are controlled (ATR of pullback candles vs impulse)
function pullbacksControlled(candles, highs, lows, trend) {
  if (highs.length < 2 || lows.length < 2) return false;
  // Compare avg candle range during pullback vs impulse legs
  const swings = trend==='up'
    ? lows.slice(-2).map(l=>l.i)
    : highs.slice(-2).map(h=>h.i);
  if (swings.length < 2) return true; // can't determine, assume ok
  const pullbackCandles = candles.slice(swings[0], swings[1]+1);
  const avgRange = pullbackCandles.reduce((a,c)=>a+(c.h-c.l),0) / (pullbackCandles.length||1);
  const recentATR = candles.slice(-20).reduce((a,c)=>a+(c.h-c.l),0) / 20;
  // Pullback candles should not be larger than 1.5x recent ATR on average
  return avgRange < recentATR * 1.5;
}

// Step 3: candles compressing (shrinking ranges) into trendline
function compressionOk(candles, trendline, trend, lastATR) {
  const li = candles.length-1;
  const lv = trendline.slope*li+trendline.intercept;
  const dist = Math.abs(candles[li].c-lv);

  // Price must be close to trendline
  if (dist > lastATR*1.2) return {ok:false, reason:'Price too far from trendline for low-risk entry.'};

  // Recent candles should be smaller than prior (spring tightening)
  const recentRanges = candles.slice(-5).map(c=>c.h-c.l);
  const priorRanges  = candles.slice(-15,-5).map(c=>c.h-c.l);
  const avgRecent = recentRanges.reduce((a,b)=>a+b,0)/recentRanges.length;
  const avgPrior  = priorRanges.reduce((a,b)=>a+b,0)/priorRanges.length;
  if (avgRecent >= avgPrior*0.98) return {ok:false, reason:'No candle compression — ranges not shrinking into line.'};

  return {ok:true};
}

// Step 4: strong body close beyond trendline
function breakConfirmed(candles, trendline, trend) {
  const last = candles[candles.length-1];
  const lv   = trendline.slope*(candles.length-1)+trendline.intercept;
  const body  = Math.abs(last.c-last.o);
  const range = last.h-last.l||1e-9;
  const beyond = trend==='up' ? last.c>lv : last.c<lv;
  const bodyDominant = body/range > 0.55;
  return {beyond, bodyDominant, bodyRatio:(body/range*100).toFixed(0)};
}

// Step 1: no major S/R directly in trade path (uses recent swing highs/lows as proxy)
function clearPathToTarget(entry, target, highs, lows, trend) {
  const obstacles = trend==='up'
    ? highs.filter(h=>h.price>entry && h.price<target)
    : lows.filter(l=>l.price<entry && l.price>target);
  // Allow up to 1 minor S/R level in path — block if 2+
  return obstacles.length <= 1;
}

function analyze(symbol, candles) {
  if (candles.length < 60) return null;

  const atrSeries = calcATR(candles,14);
  const lastATR   = atrSeries[atrSeries.length-1];
  const {highs,lows} = findPivots(candles,3);

  // STEP 1: Trend (HH/HL or LH/LL, 2+ impulsive legs)
  let trend=null;
  if (highs.length>=2 && lows.length>=2) {
    const h1=highs[highs.length-2], h2=highs[highs.length-1];
    const l1=lows[lows.length-2],  l2=lows[lows.length-1];
    if (h2.price>h1.price && l2.price>l1.price) trend='up';
    else if (h2.price<h1.price && l2.price<l1.price) trend='down';
  }
  if (!trend) return null;

  // Step 1: pullbacks controlled
  if (!pullbacksControlled(candles, highs, lows, trend)) return null;

  // STEP 2: Trendline — 2–3 clean swing points, moderate angle, max 1 prior failed break
  const H4W = 30; // H4 candles per week
  const pool = trend==='up' ? lows : highs;
  const taps = findValidTaps(pool, 4, 2, 3);
  if (!taps) return null;

  // Minimum 1 week of H4 data (Step 3)
  const span = taps[taps.length-1].i - taps[0].i;
  if (span < H4W) return null;

  const trendline = linReg(taps);
  if (!slopeOk(Math.abs(trendline.slope), lastATR)) return null;

  // Max 1 prior failed break
  const priorBreaks = countPriorBreaks(candles, trendline, trend);
  if (priorBreaks > 1) return null;

  // STEP 3: Compression
  const comp = compressionOk(candles, trendline, trend, lastATR);
  if (!comp.ok) return null;

  // STEP 4: Break confirmation
  const brk = breakConfirmed(candles, trendline, trend);
  if (!brk.beyond || !brk.bodyDominant) return null;

  // STEP 5: Entry, stop, target
  const entry = candles[candles.length-1].c;
  const li    = candles.length-1;
  const tlv   = trendline.slope*li+trendline.intercept;

  // Safety line from opposing trendline
  const oppPool  = trend==='up' ? highs : lows;
  const oppTaps  = findValidTaps(oppPool,4,2,3) || oppPool.slice(-2);
  const safetyLine = oppTaps&&oppTaps.length>=2 ? linReg(oppTaps) : null;

  let stop;
  if (safetyLine) {
    const sv = safetyLine.slope*(li+4)+safetyLine.intercept;
    const valid = trend==='up' ? sv<entry : sv>entry;
    stop = valid ? sv : (trend==='up' ? tlv-lastATR*0.5 : tlv+lastATR*0.5);
  } else {
    stop = trend==='up' ? tlv-lastATR*0.5 : tlv+lastATR*0.5;
  }

  const riskDist = Math.abs(entry-stop);
  if (riskDist===0) return null;

  // Target: nearest S/R giving 2–2.5R+ (Step 3)
  let target;
  if (trend==='up') {
    const fh = highs.filter(h=>h.price>entry);
    target = fh.length ? Math.min(...fh.map(h=>h.price)) : entry+riskDist*2.5;
  } else {
    const fl = lows.filter(l=>l.price<entry);
    target = fl.length ? Math.max(...fl.map(l=>l.price)) : entry-riskDist*2.5;
  }

  const reward    = Math.abs(target-entry);
  const rMultiple = reward/riskDist;
  if (rMultiple < 2) return null;

  // Step 1: no major S/R blocking path
  if (!clearPathToTarget(entry, target, highs, lows, trend)) return null;

  // Liquidity sweep heuristic (Step 0)
  let sweep=false;
  if (trend==='up' && lows.length>=2) {
    const pr=lows[lows.length-2];
    sweep=candles.slice(pr.i+1,pr.i+8).some(c=>c.l<pr.price&&c.c>pr.price);
  } else if (trend==='down' && highs.length>=2) {
    const pr=highs[highs.length-2];
    sweep=candles.slice(pr.i+1,pr.i+8).some(c=>c.h>pr.price&&c.c<pr.price);
  }

  const dec = symbol.includes('JPY') ? 3 : 5;
  return {
    direction: trend==='up'?'Long':'Short',
    entry: entry.toFixed(dec),
    stop:  stop.toFixed(dec),
    target: target.toFixed(dec),
    taps: taps.length,
    spanWeeks: (span/H4W).toFixed(1),
    priorBreaks,
    rMultiple: rMultiple.toFixed(1),
    sweep,
    bodyRatio: brk.bodyRatio,
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
      if (data.status==='error'||!data.values) { await sleep(900); continue; }
      const candles = data.values.map(v=>({
        t:new Date(v.datetime).getTime(),
        o:parseFloat(v.open),h:parseFloat(v.high),l:parseFloat(v.low),c:parseFloat(v.close)
      })).reverse();
      const result = analyze(symbol, candles);
      if (result) signals.push({symbol, ...result});
    } catch(e) {
      console.error(`Error for ${symbol}:`, e.message);
    }
    await sleep(900);
  }

  if (signals.length===0) {
    console.log('No A+ signals found. No notification sent.');
    return;
  }

  const title = `📈 ${signals.length} A+ signal${signals.length>1?'s':''} — Spiraled H4`;
  const message = signals.map(s =>
    `${s.symbol} — ${s.direction}\n` +
    `${s.taps}-tap trendline (${s.spanWeeks}wks)${s.priorBreaks===1?' | 1 prior failed break':''}\n` +
    `Body: ${s.bodyRatio}% | R: ${s.rMultiple}R\n` +
    `Entry: ${s.entry} | Stop: ${s.stop} | Target: ${s.target}\n` +
    `${s.sweep?'✓ Liquidity sweep detected':'⚠️ No clear sweep — check manually'}\n` +
    `⚠️ Verify chart + check news before entering`
  ).join('\n\n');

  await notify(title, message);
  console.log('Notification sent for:', signals.map(s=>s.symbol).join(', '));
}

main();
