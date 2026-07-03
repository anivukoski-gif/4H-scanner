const https = require('https');

const PAIRS = ["EUR/USD","GBP/USD","USD/JPY","EUR/JPY","GBP/JPY"];
const API_KEY = process.env.TWELVEDATA_KEY;
const MAX_HOLD_CANDLES = 60; // max ~10 days on H4 before forced exit
const COOLDOWN_CANDLES = 20; // no re-entry for 20 candles after a trade

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Analysis helpers (identical to scan.js) ──────────────────────────────────

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

function findValidTaps(pts, minSpacing=6, minTaps=3) {
  const taps=[];
  for (let i=pts.length-1; i>=0; i--) {
    if (taps.length===0) { taps.unshift(pts[i]); }
    else if (taps[0].i-pts[i].i >= minSpacing) { taps.unshift(pts[i]); }
    if (taps.length >= minTaps) break;
  }
  return taps.length >= minTaps ? taps : null;
}

function slopeOk(slope, atr) { const a=Math.abs(slope); return a>atr*0.03 && a<atr*0.5; }

function priorBreakExists(candles, tl, trend) {
  let crossings=0;
  const from=Math.max(0, candles.length-25);
  for (let i=from; i<candles.length-1; i++) {
    const lv=tl.slope*i+tl.intercept;
    if (trend==='up' ? candles[i].c>lv : candles[i].c<lv) crossings++;
  }
  return crossings > 3;
}

function detectSignal(candles) {
  if (candles.length < 90) return null;
  const atrSeries=calcATR(candles,14);
  const lastATR=atrSeries[atrSeries.length-1];
  const {highs,lows}=findPivots(candles,3);

  // Trend
  let trend=null;
  if (highs.length>=2 && lows.length>=2) {
    const h1=highs[highs.length-2], h2=highs[highs.length-1];
    const l1=lows[lows.length-2], l2=lows[lows.length-1];
    if (h2.price>h1.price && l2.price>l1.price) trend='up';
    else if (h2.price<h1.price && l2.price<l1.price) trend='down';
  }
  if (!trend) return null;

  // 3 taps, spacing, 3 weeks
  const H4W=30;
  const pool=trend==='up'?lows:highs;
  const taps=findValidTaps(pool,6,3);
  if (!taps) return null;
  const span=taps[taps.length-1].i-taps[0].i;
  if (span < 3*H4W) return null;

  const trendline=linReg(taps);
  if (!slopeOk(Math.abs(trendline.slope),lastATR)) return null;
  if (priorBreakExists(candles,trendline,trend)) return null;

  // Compression
  const li=candles.length-1;
  const lv=trendline.slope*li+trendline.intercept;
  const dist=Math.abs(candles[li].c-lv);
  const atrR=atrSeries.slice(-5).reduce((a,b)=>a+b,0)/5;
  const atrP=atrSeries.slice(-20,-5).reduce((a,b)=>a+b,0)/15;
  if (atrR>=atrP*0.92 || dist>=lastATR*0.8) return null;

  // Break confirmation
  const last=candles[candles.length-1];
  const tlv=trendline.slope*(candles.length-1)+trendline.intercept;
  const body=Math.abs(last.c-last.o);
  const range=last.h-last.l||1e-9;
  const beyond=trend==='up'?last.c>tlv:last.c<tlv;
  if (!beyond || body/range<=0.55) return null;

  // Safety line stop
  const entry=last.c;
  const oppPool=trend==='up'?highs:lows;
  const oppTaps=findValidTaps(oppPool,4,2)||oppPool.slice(-2);
  const safetyLine=oppTaps&&oppTaps.length>=2?linReg(oppTaps):null;

  let stop;
  if (safetyLine) {
    const sv=safetyLine.slope*(li+4)+safetyLine.intercept;
    const valid=trend==='up'?sv<entry:sv>entry;
    stop=valid?sv:(trend==='up'?tlv-lastATR*0.5:tlv+lastATR*0.5);
  } else {
    stop=trend==='up'?tlv-lastATR*0.5:tlv+lastATR*0.5;
  }

  const riskDist=Math.abs(entry-stop);
  if (riskDist===0) return null;

  let target;
  if (trend==='up') {
    const fh=highs.filter(h=>h.price>entry);
    target=fh.length?Math.min(...fh.map(h=>h.price)):entry+riskDist*2.5;
  } else {
    const fl=lows.filter(l=>l.price<entry);
    target=fl.length?Math.max(...fl.map(l=>l.price)):entry-riskDist*2.5;
  }

  const reward=Math.abs(target-entry);
  const rMultiple=reward/riskDist;
  if (rMultiple<2) return null;

  return {trend, direction:trend==='up'?'Long':'Short', entry, stop, target, rMultiple, riskDist};
}

// ── Backtest engine ───────────────────────────────────────────────────────────

function backtestPair(symbol, candles) {
  const trades = [];
  let cooldown = 0;

  for (let i = 100; i < candles.length - MAX_HOLD_CANDLES; i++) {
    if (cooldown > 0) { cooldown--; continue; }

    const slice = candles.slice(0, i + 1);
    const signal = detectSignal(slice);
    if (!signal) continue;

    // Simulate trade on future candles
    const { direction, entry, stop, target, rMultiple, riskDist } = signal;
    let outcome = 'timeout';
    let actualR = 0;
    let exitCandle = i;

    for (let j = i + 1; j <= i + MAX_HOLD_CANDLES && j < candles.length; j++) {
      const c = candles[j];

      // Check stop first (worst case within candle)
      if (direction === 'Long') {
        if (c.l <= stop) {
          outcome = 'loss';
          actualR = -1;
          exitCandle = j;
          break;
        }
        if (c.h >= target) {
          outcome = 'win';
          actualR = rMultiple;
          exitCandle = j;
          break;
        }
      } else {
        if (c.h >= stop) {
          outcome = 'loss';
          actualR = -1;
          exitCandle = j;
          break;
        }
        if (c.l <= target) {
          outcome = 'win';
          actualR = rMultiple;
          exitCandle = j;
          break;
        }
      }
    }

    // Timeout: exit at last candle price vs entry
    if (outcome === 'timeout') {
      const exitPrice = candles[i + MAX_HOLD_CANDLES].c;
      const pnl = direction==='Long' ? exitPrice-entry : entry-exitPrice;
      actualR = pnl / riskDist;
      exitCandle = i + MAX_HOLD_CANDLES;
    }

    const entryDate = new Date(candles[i].t).toISOString().split('T')[0];
    const exitDate  = new Date(candles[exitCandle].t).toISOString().split('T')[0];

    trades.push({ symbol, direction, outcome, actualR: parseFloat(actualR.toFixed(2)), entryDate, exitDate, rMultiple: parseFloat(rMultiple.toFixed(2)) });
    cooldown = COOLDOWN_CANDLES;
  }

  return trades;
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function calcStats(trades) {
  if (trades.length === 0) return null;

  const wins   = trades.filter(t => t.outcome === 'win');
  const losses = trades.filter(t => t.outcome === 'loss');
  const timeouts = trades.filter(t => t.outcome === 'timeout');

  const winRate = (wins.length / trades.length * 100).toFixed(1);
  const totalR  = trades.reduce((a,t) => a+t.actualR, 0).toFixed(2);
  const avgR    = (trades.reduce((a,t) => a+t.actualR, 0) / trades.length).toFixed(2);
  const avgWin  = wins.length  ? (wins.reduce((a,t)=>a+t.actualR,0)/wins.length).toFixed(2)   : 'N/A';
  const avgLoss = losses.length? (losses.reduce((a,t)=>a+t.actualR,0)/losses.length).toFixed(2): 'N/A';

  // Max drawdown (consecutive R loss)
  let peak=0, maxDD=0, running=0;
  for (const t of trades) {
    running += t.actualR;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDD) maxDD = dd;
  }

  // Max consecutive losses
  let maxConsecLoss=0, consecLoss=0;
  for (const t of trades) {
    if (t.actualR < 0) { consecLoss++; maxConsecLoss=Math.max(maxConsecLoss,consecLoss); }
    else consecLoss=0;
  }

  return { total:trades.length, wins:wins.length, losses:losses.length, timeouts:timeouts.length,
           winRate, totalR, avgR, avgWin, avgLoss, maxDD:maxDD.toFixed(2), maxConsecLoss };
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchCandles(symbol, apiKey) {
  // Try to get as much history as possible — free tier typically returns up to 5000
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=4h&outputsize=5000&apikey=${apiKey}`;
  const data = await get(url);
  if (data.status === 'error' || !data.values) throw new Error(data.message || 'No data');
  return data.values.map(v=>({
    t: new Date(v.datetime).getTime(),
    o: parseFloat(v.open), h: parseFloat(v.high),
    l: parseFloat(v.low),  c: parseFloat(v.close)
  })).reverse();
}

// ── Main ──────────────────────────────────────────────────────────────────────

function printSeparator(char='-', len=60) { console.log(char.repeat(len)); }

async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  SPIRALED — H4 STRATEGY BACKTEST');
  console.log('  Walk-forward simulation | No look-ahead');
  console.log('═'.repeat(60));
  console.log(`  Pairs: ${PAIRS.join(', ')}`);
  console.log(`  Max hold: ${MAX_HOLD_CANDLES} candles (~${(MAX_HOLD_CANDLES/6).toFixed(0)} trading days)`);
  console.log(`  Cooldown after trade: ${COOLDOWN_CANDLES} candles`);
  console.log('═'.repeat(60) + '\n');

  const allTrades = [];

  for (const symbol of PAIRS) {
    console.log(`\nFetching ${symbol}...`);
    try {
      const candles = await fetchCandles(symbol, API_KEY);
      const startDate = new Date(candles[0].t).toISOString().split('T')[0];
      const endDate   = new Date(candles[candles.length-1].t).toISOString().split('T')[0];
      console.log(`  ${candles.length} candles loaded (${startDate} → ${endDate})`);

      const trades = backtestPair(symbol, candles);
      allTrades.push(...trades);
      const stats = calcStats(trades);

      printSeparator();
      console.log(`  ${symbol} — ${trades.length} trades`);
      printSeparator();

      if (!stats) {
        console.log('  No trades generated for this pair.\n');
      } else {
        console.log(`  Win rate:            ${stats.winRate}%  (${stats.wins}W / ${stats.losses}L / ${stats.timeouts} timeout)`);
        console.log(`  Total R:             ${stats.totalR}R`);
        console.log(`  Avg R per trade:     ${stats.avgR}R`);
        console.log(`  Avg win:             ${stats.avgWin}R`);
        console.log(`  Avg loss:            ${stats.avgLoss}R`);
        console.log(`  Max drawdown:        ${stats.maxDD}R`);
        console.log(`  Max consec. losses:  ${stats.maxConsecLoss}`);
        console.log('');
        console.log('  Trade log:');
        for (const t of trades) {
          const icon = t.outcome==='win'?'✓':t.outcome==='loss'?'✗':'~';
          console.log(`    ${icon} ${t.entryDate}  ${t.direction.padEnd(6)}  ${t.outcome.padEnd(8)}  ${String(t.actualR+'R').padStart(7)}  (target was ${t.rMultiple}R)`);
        }
      }
    } catch(e) {
      console.log(`  ERROR: ${e.message}`);
    }

    await sleep(1200);
  }

  // Combined stats
  console.log('\n' + '═'.repeat(60));
  console.log('  COMBINED RESULTS — ALL PAIRS');
  console.log('═'.repeat(60));
  const combined = calcStats(allTrades);
  if (!combined) {
    console.log('  No trades generated across any pair.');
  } else {
    console.log(`  Total trades:        ${combined.total}`);
    console.log(`  Win rate:            ${combined.winRate}%`);
    console.log(`  Total R:             ${combined.totalR}R`);
    console.log(`  Avg R per trade:     ${combined.avgR}R`);
    console.log(`  Avg win:             ${combined.avgWin}R`);
    console.log(`  Avg loss:            ${combined.avgLoss}R`);
    console.log(`  Max drawdown:        ${combined.maxDD}R`);
    console.log(`  Max consec. losses:  ${combined.maxConsecLoss}`);
    console.log('');
    if (parseFloat(combined.avgR) > 0) {
      console.log('  ✅ Positive expectancy — strategy has edge over this period.');
    } else {
      console.log('  ⚠️  Negative expectancy over this period — review rules or sample size.');
    }
  }
  console.log('═'.repeat(60) + '\n');
}

main();
