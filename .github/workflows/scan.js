<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Spiraled — H4 Trade Scanner</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Jost:wght@300;400;500;600&display=swap');

  :root{
    --cream:#F4EFE6;
    --paper:#FBF8F2;
    --ink:#2E2A24;
    --terracotta:#B5654A;
    --terracotta-deep:#9A4F38;
    --sage:#7C8466;
    --line:#DCD3C2;
    --muted:#8C8475;
    --no:#B5654A;
    --yes:#5F7A52;
  }
  *{box-sizing:border-box;}
  body{
    margin:0;
    background:var(--cream);
    color:var(--ink);
    font-family:'Jost',sans-serif;
    font-weight:300;
    -webkit-font-smoothing:antialiased;
  }
  h1,h2,h3,.serif{font-family:'Cormorant Garamond',serif;}
  .wrap{max-width:880px;margin:0 auto;padding:36px 22px 80px;}

  header{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:8px;}
  header h1{font-size:34px;font-weight:600;margin:0;letter-spacing:.01em;}
  header .tag{font-size:13px;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;}
  .lede{color:var(--muted);font-size:14.5px;margin:2px 0 28px;max-width:60ch;line-height:1.5;}

  .panel{background:var(--paper);border:1px solid var(--line);border-radius:2px;padding:20px 22px;margin-bottom:18px;}
  .panel-title{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin:0 0 14px;display:flex;align-items:center;gap:8px;}
  .panel-title::after{content:"";flex:1;height:1px;background:var(--line);}

  label{display:block;font-size:12.5px;color:var(--muted);margin-bottom:5px;}
  input[type=text],input[type=password],input[type=number]{
    width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:2px;
    background:#fff;font-family:'Jost',sans-serif;font-size:14px;color:var(--ink);
  }
  input:focus{outline:1px solid var(--terracotta);}
  .row{display:flex;gap:14px;flex-wrap:wrap;}
  .row > div{flex:1;min-width:140px;}

  button{
    font-family:'Jost',sans-serif;font-weight:500;font-size:13px;letter-spacing:.04em;
    background:var(--ink);color:var(--paper);border:none;border-radius:2px;
    padding:11px 20px;cursor:pointer;transition:opacity .15s;
  }
  button:hover{opacity:.85;}
  button.secondary{background:transparent;color:var(--ink);border:1px solid var(--line);}
  button:disabled{opacity:.4;cursor:not-allowed;}
  button:focus-visible, input:focus-visible, summary:focus-visible{outline:2px solid var(--terracotta);outline-offset:2px;}

  .keyrow{display:flex;gap:10px;align-items:flex-end;}
  .keyrow > div{flex:1;}
  .status-line{font-size:12px;color:var(--muted);margin-top:8px;}
  .status-line.ok{color:var(--yes);}
  .status-line.err{color:var(--no);}

  .scan-btn{margin-top:18px;width:100%;padding:14px;font-size:14px;}

  .checklist{display:flex;flex-direction:column;gap:10px;margin-top:4px;}
  .checklist label{display:flex;align-items:flex-start;gap:10px;font-size:13.5px;color:var(--ink);cursor:pointer;}
  .checklist input[type=checkbox]{width:16px;height:16px;margin-top:2px;accent-color:var(--terracotta);}
  .helper-link{color:var(--terracotta-deep);text-decoration:underline;text-underline-offset:2px;}

  .cards{display:flex;flex-direction:column;gap:16px;margin-top:8px;}
  .card{background:var(--paper);border:1px solid var(--line);border-radius:2px;overflow:hidden;}
  .card-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--line);}
  .card-head .pair{font-family:'Cormorant Garamond',serif;font-size:24px;font-weight:600;}
  .verdict{font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:5px 11px;border-radius:20px;font-weight:500;}
  .verdict.yes{background:rgba(95,122,82,.14);color:var(--yes);}
  .verdict.no{background:rgba(181,101,74,.13);color:var(--no);}
  .verdict.pending{background:rgba(140,132,117,.13);color:var(--muted);}

  .card-body{padding:18px 20px;}
  .steps{display:flex;flex-direction:column;gap:8px;}
  .step{display:flex;gap:10px;align-items:flex-start;font-size:13.5px;line-height:1.45;}
  .step .mark{width:16px;flex-shrink:0;font-size:13px;margin-top:1px;}
  .step.pass .mark{color:var(--yes);}
  .step.fail .mark{color:var(--no);}
  .step .label{color:var(--ink);}
  .step .detail{color:var(--muted);}

  .divider{height:1px;background:var(--line);margin:14px 0;}

  .trade-summary{background:rgba(181,101,74,.06);border:1px solid rgba(181,101,74,.25);border-radius:2px;padding:14px 16px;margin-top:14px;}
  .trade-summary .row2{display:flex;justify-content:space-between;font-size:13px;padding:3px 0;}
  .trade-summary .row2 .k{color:var(--muted);}
  .trade-summary .row2 .v{font-weight:500;}

  .manual-block{margin-top:14px;padding-top:14px;border-top:1px dashed var(--line);}
  .manual-block .panel-title{margin-bottom:10px;}

  .err-box{padding:14px 20px;color:var(--no);font-size:13px;}
  .loading{padding:30px;text-align:center;color:var(--muted);font-size:13px;}

  footer{margin-top:30px;font-size:11.5px;color:var(--muted);line-height:1.6;text-align:center;}

  @media (prefers-reduced-motion: reduce){ *{transition:none !important;} }
</style>
</head>
<body>
<div class="wrap">

  <header>
    <h1>Spiraled</h1>
    <div class="tag">H4 Trade Scanner</div>
  </header>
  <p class="lede">Runs your 8-step trend-break framework against live H4 candles. Objective steps are checked automatically; the two judgment calls (news risk, "does this look forced") are yours to confirm per pair.</p>

  <div class="panel" id="setupPanel">
    <div class="panel-title">Data source</div>
    <div class="keyrow">
      <div>
        <label for="apiKey">Twelve Data API key</label>
        <input type="password" id="apiKey" placeholder="paste your free key from twelvedata.com">
      </div>
      <button class="secondary" id="saveKeyBtn">Save key</button>
    </div>
    <div class="status-line" id="keyStatus">Free tier: 800 calls/day, 8/min — plenty for 5 pairs once a day. Key is stored only on this device.</div>

    <div class="row" style="margin-top:16px;">
      <div>
        <label for="accountSize">Account size (optional, for position sizing)</label>
        <input type="number" id="accountSize" placeholder="e.g. 10000">
      </div>
      <div>
        <label for="riskPct">Risk per trade %</label>
        <input type="number" id="riskPct" value="0.5" step="0.05">
      </div>
    </div>

    <button class="scan-btn" id="scanBtn">Scan all pairs</button>
    <div class="status-line" id="scanStatus"></div>
  </div>

  <div id="results" class="cards"></div>

  <footer>
    Heuristic scanner, not financial advice. Trend, structure, compression and break checks are computed from price action; liquidity-sweep and R:R figures are approximations. Always verify visually before sizing a trade.
  </footer>
</div>

<script>
const PAIRS = ["EUR/USD","GBP/USD","USD/JPY","EUR/JPY","GBP/JPY"];
const apiKeyInput = document.getElementById('apiKey');
const keyStatus = document.getElementById('keyStatus');
const resultsEl = document.getElementById('results');
const scanStatus = document.getElementById('scanStatus');
const scanBtn = document.getElementById('scanBtn');

// ---------- storage ----------
// Tries Claude's artifact storage first (works when opened as a Claude artifact link),
// falls back to plain localStorage (works when opened as a standalone file/page).
const hasArtifactStorage = typeof window.storage !== 'undefined';

async function loadKey(){
  try{
    if(hasArtifactStorage){
      const r = await window.storage.get('twelvedata_api_key', false);
      if(r && r.value){ apiKeyInput.value = r.value; keyStatus.textContent = 'Saved key loaded.'; keyStatus.className='status-line ok'; }
      return;
    }
  }catch(e){ /* fall through to localStorage */ }
  try{
    const v = localStorage.getItem('twelvedata_api_key');
    if(v){ apiKeyInput.value = v; keyStatus.textContent = 'Saved key loaded from this browser.'; keyStatus.className='status-line ok'; }
  }catch(e){ /* private browsing or storage blocked */ }
}

document.getElementById('saveKeyBtn').addEventListener('click', async ()=>{
  const v = apiKeyInput.value.trim();
  if(!v){ keyStatus.textContent='Enter a key first.'; keyStatus.className='status-line err'; return; }
  if(hasArtifactStorage){
    try{
      await window.storage.set('twelvedata_api_key', v, false);
      keyStatus.textContent='Key saved.'; keyStatus.className='status-line ok';
      return;
    }catch(e){ /* fall through to localStorage */ }
  }
  try{
    localStorage.setItem('twelvedata_api_key', v);
    keyStatus.textContent='Key saved in this browser.'; keyStatus.className='status-line ok';
  }catch(e){
    keyStatus.textContent='Could not persist the key (private/incognito mode?). You can still scan — just re-paste it each visit.';
    keyStatus.className='status-line err';
  }
});
loadKey();

// ---------- data fetch ----------
async function fetchCandles(symbol, apiKey){
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=4h&outputsize=200&apikey=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  if(data.status === 'error' || !data.values){
    throw new Error(data.message || 'No data returned');
  }
  // API returns most-recent-first; reverse to ascending
  const candles = data.values.map(v=>({
    t: new Date(v.datetime).getTime(),
    o: parseFloat(v.open), h: parseFloat(v.high), l: parseFloat(v.low), c: parseFloat(v.close)
  })).reverse();
  return candles;
}

// ---------- analysis primitives ----------
function atr(candles, period){
  const trs = [];
  for(let i=1;i<candles.length;i++){
    const c = candles[i], p = candles[i-1];
    trs.push(Math.max(c.h-c.l, Math.abs(c.h-p.c), Math.abs(c.l-p.c)));
  }
  const out = [];
  for(let i=0;i<trs.length;i++){
    const slice = trs.slice(Math.max(0,i-period+1), i+1);
    out.push(slice.reduce((a,b)=>a+b,0)/slice.length);
  }
  return out;
}

function findPivots(candles, lookback=3){
  const highs=[], lows=[];
  for(let i=lookback;i<candles.length-lookback;i++){
    const w = candles.slice(i-lookback,i+lookback+1);
    const c = candles[i];
    if(c.h === Math.max(...w.map(x=>x.h))) highs.push({i, t:c.t, price:c.h});
    if(c.l === Math.min(...w.map(x=>x.l))) lows.push({i, t:c.t, price:c.l});
  }
  return {highs, lows};
}

function linReg(points){
  const n = points.length;
  const sumX = points.reduce((a,p)=>a+p.i,0);
  const sumY = points.reduce((a,p)=>a+p.price,0);
  const sumXY = points.reduce((a,p)=>a+p.i*p.price,0);
  const sumXX = points.reduce((a,p)=>a+p.i*p.i,0);
  const slope = (n*sumXY - sumX*sumY) / (n*sumXX - sumX*sumX || 1);
  const intercept = (sumY - slope*sumX) / n;
  return {slope, intercept};
}

// Find 3+ taps with 6+ candle spacing between each — core Tori rule
function findValidTaps(points, minSpacing=6, minTaps=3){
  // Work backwards from most recent pivot, collect taps with enough spacing
  const taps = [];
  for(let i=points.length-1; i>=0; i--){
    if(taps.length === 0){
      taps.unshift(points[i]);
    } else {
      const gap = taps[0].i - points[i].i;
      if(gap >= minSpacing) taps.unshift(points[i]);
    }
    if(taps.length >= minTaps) break;
  }
  return taps.length >= minTaps ? taps : null;
}

// Approximate whether trendline slope is under 45° (Tori's visual rule)
// On H4 with 3 months visible (~540 candles), 45° means total price move equals chart height.
// We proxy this: slope per bar should be < 0.5× ATR (steep) and > 0.03× ATR (flat).
function slopeOk(slope, lastATR){
  const abs = Math.abs(slope);
  return abs > lastATR * 0.03 && abs < lastATR * 0.5;
}

// Check for prior trendline break — "one trade per trendline" rule
// If price already crossed the line in the 20 candles before the most recent one, skip.
function priorBreakExists(candles, trendline, trend){
  const checkFrom = Math.max(0, candles.length - 25);
  const checkTo = candles.length - 2; // exclude the current/last candle
  let crossings = 0;
  for(let i=checkFrom; i<=checkTo; i++){
    const lineVal = trendline.slope*i + trendline.intercept;
    const c = candles[i];
    const wasBeyond = trend==='up' ? c.c > lineVal : c.c < lineVal;
    if(wasBeyond) crossings++;
  }
  // If more than 3 candles already closed beyond the line, treat as a prior break
  return crossings > 3;
}

function analyzePair(symbol, candles){
  const steps = [];
  let overallPass = true;
  const fail = (label, detail) => { steps.push({label, detail, pass:false}); overallPass=false; };
  const pass = (label, detail) => { steps.push({label, detail, pass:true}); };

  if(candles.length < 90){
    return { symbol, overallPass:false, steps:[{label:'Insufficient data', detail:`Only ${candles.length} candles returned — need at least 90`, pass:false}], tradeData:null };
  }

  const atrSeries = atr(candles, 14);
  const lastATR = atrSeries[atrSeries.length-1];
  const {highs, lows} = findPivots(candles, 3);

  // --- Step 1: Trend (HH/HL or LH/LL) ---
  let trend = null;
  if(highs.length>=2 && lows.length>=2){
    const h1=highs[highs.length-2], h2=highs[highs.length-1];
    const l1=lows[lows.length-2], l2=lows[lows.length-1];
    if(h2.price>h1.price && l2.price>l1.price) trend='up';
    else if(h2.price<h1.price && l2.price<l1.price) trend='down';
  }

  if(!trend){
    fail('Market environment', 'No clean HH/HL or LH/LL sequence — choppy or ranging.');
  } else {
    pass('Market environment', `Clear ${trend==='up'?'uptrend (HH/HL)':'downtrend (LH/LL)'} with ≥2 impulsive legs.`);
  }

  // --- Step 2: Trendline — 3+ taps, 6+ candles between each, 3+ weeks of data ---
  let trendline = null, taps = null;
  const H4_PER_WEEK = 30; // ~6 candles/day × 5 trading days
  const MIN_WEEKS = 3;

  if(trend){
    const swingPool = trend==='up' ? lows : highs;
    taps = findValidTaps(swingPool, 6, 3);

    if(!taps){
      fail('Trendline quality (3 taps)', 'Fewer than 3 taps with 6+ candle spacing found — trendline not yet confirmed by Tori\'s rules.');
    } else {
      const spanCandles = taps[taps.length-1].i - taps[0].i;
      const spanWeeks = (spanCandles / H4_PER_WEEK).toFixed(1);
      if(spanCandles < MIN_WEEKS * H4_PER_WEEK){
        fail('Trendline quality (3 weeks)', `Trendline spans only ≈${spanWeeks} weeks — Tori requires 3+ weeks of price data from first tap to break.`);
      } else {
        trendline = linReg(taps);
        const perBarMove = Math.abs(trendline.slope);
        if(!slopeOk(perBarMove, lastATR)){
          const reason = perBarMove >= lastATR*0.5 ? 'Slope too steep (approaches 45°+ when charted).' : 'Slope too flat — barely a trend.';
          fail('Trendline quality (slope)', reason);
          trendline = null;
        } else {
          pass('Trendline quality', `${taps.length} taps, each 6+ candles apart, spanning ≈${spanWeeks} weeks, moderate slope. ✓`);
        }
      }
    }
  } else {
    fail('Trendline quality', 'Skipped — no trend established.');
  }

  // --- Step 3: One trade per trendline — no prior break ---
  if(trendline){
    const alreadyBroken = priorBreakExists(candles, trendline, trend);
    if(alreadyBroken){
      fail('One trade per trendline', 'Price already broke this trendline in the last 20 candles. Tori\'s rule: only one trade attempt per line — skip.');
      trendline = null;
    } else {
      pass('One trade per trendline', 'No prior break detected on this trendline. First attempt — valid.');
    }
  } else if(trend) {
    // already failed above, skip silently
  }

  // --- Step 4: Compression ---
  let compressionOk = false;
  if(trendline){
    const lastIdx = candles.length-1;
    const lineVal = trendline.slope*lastIdx + trendline.intercept;
    const distToLine = Math.abs(candles[lastIdx].c - lineVal);
    const atrRecent = atrSeries.slice(-5).reduce((a,b)=>a+b,0)/5;
    const atrPrior = atrSeries.slice(-20,-5).reduce((a,b)=>a+b,0)/15;
    const contracting = atrRecent < atrPrior*0.92;
    const closeToLine = distToLine < lastATR*0.8;
    compressionOk = contracting && closeToLine;
    if(compressionOk){
      pass('Compression', `Volatility contracting (ATR ${atrRecent.toFixed(4)} vs prior ${atrPrior.toFixed(4)}) and price close to the line.`);
    } else {
      fail('Compression', !contracting ? 'No volatility contraction — candles not tightening into the line.' : 'Price too far from trendline for a low-risk entry.');
    }
  } else if(trend){
    fail('Compression', 'Skipped — no valid trendline.');
  }

  // --- Step 5: Break confirmation (body-dominant H4 close) ---
  let breakOk = false, breakCandle = null;
  if(trendline){
    const last = candles[candles.length-1];
    const lineValLast = trendline.slope*(candles.length-1) + trendline.intercept;
    const body = Math.abs(last.c - last.o);
    const range = last.h - last.l || 1e-9;
    const bodyRatio = body/range;
    const beyond = trend==='up' ? last.c > lineValLast : last.c < lineValLast;
    breakOk = beyond && bodyRatio > 0.55;
    breakCandle = last;
    if(breakOk){
      pass('Break confirmation', `H4 candle closed ${trend==='up'?'above':'below'} action line with ${(bodyRatio*100).toFixed(0)}% body dominance. ✓`);
    } else {
      fail('Break confirmation', !beyond ? 'Price has not closed beyond the trendline yet — wait for the candle close.' : 'Close is beyond the line but candle is wick-heavy — not a valid break candle.');
    }
  } else if(trend){
    fail('Break confirmation', 'Skipped — no valid trendline.');
  }

  // --- Step 6: Safety line (opposing trendline) + stop at 4th candle projection ---
  let tradeData = null;
  if(breakOk && compressionOk){
    // Draw opposing trendline as safety line
    const opposingPool = trend==='up' ? highs : lows;
    const opposingTaps = findValidTaps(opposingPool, 4, 2) || opposingPool.slice(-2);
    const safetyLine = opposingTaps && opposingTaps.length >= 2 ? linReg(opposingTaps) : null;

    const entry = breakCandle.c;
    const lastIdx = candles.length-1;

    // Stop: where safety line will be at the 4th candle after the break (Tori's mechanical rule)
    let stop;
    if(safetyLine){
      const stopIdx = lastIdx + 4;
      const safetyAtStop = safetyLine.slope*stopIdx + safetyLine.intercept;
      stop = safetyAtStop;
      // Sanity check: stop must be on the correct side of entry
      const stopValid = trend==='up' ? stop < entry : stop > entry;
      if(!stopValid) stop = trend==='up'
        ? (trendline.slope*lastIdx + trendline.intercept) - lastATR*0.5
        : (trendline.slope*lastIdx + trendline.intercept) + lastATR*0.5;
    } else {
      const lineValLast = trendline.slope*lastIdx + trendline.intercept;
      stop = trend==='up' ? lineValLast - lastATR*0.5 : lineValLast + lastATR*0.5;
    }

    // Target: nearest S/R that gives 2R+
    let target = null;
    if(trend==='up'){
      const futureHighs = highs.filter(h=>h.i > (lows[lows.length-1]?.i||0) && h.price > entry);
      target = futureHighs.length ? Math.min(...futureHighs.map(h=>h.price)) : null;
      if(!target) target = entry + Math.abs(entry-stop)*2.5;
    } else {
      const futureLows = lows.filter(l=>l.i > (highs[highs.length-1]?.i||0) && l.price < entry);
      target = futureLows.length ? Math.max(...futureLows.map(l=>l.price)) : null;
      if(!target) target = entry - Math.abs(entry-stop)*2.5;
    }

    const riskDist = Math.abs(entry-stop);
    const rewardDist = Math.abs(target-entry);
    const rMultiple = riskDist>0 ? rewardDist/riskDist : 0;

    // Liquidity sweep heuristic
    let sweepDetected = false;
    const recentLows = lows.slice(-3), recentHighs = highs.slice(-3);
    if(trend==='up' && recentLows.length>=2){
      const prior = recentLows[recentLows.length-2];
      sweepDetected = candles.slice(prior.i+1,prior.i+8).some(c=>c.l<prior.price && c.c>prior.price);
    } else if(trend==='down' && recentHighs.length>=2){
      const prior = recentHighs[recentHighs.length-2];
      sweepDetected = candles.slice(prior.i+1,prior.i+8).some(c=>c.h>prior.price && c.c<prior.price);
    }

    tradeData = {
      direction: trend==='up' ? 'Long' : 'Short',
      entry, stop, target, rMultiple,
      setupType: `${taps.length}-tap trendline break${sweepDetected?' + liquidity sweep':''}`,
      stopNote: safetyLine ? 'Safety line (opposing trendline) at 4th candle after break' : 'ATR-based fallback (no opposing trendline found)',
    };

    if(rMultiple < 2){
      fail('R:R to next structure', `Only ≈${rMultiple.toFixed(1)}R to next S/R — below the 2R minimum. Skip.`);
      tradeData = null;
    } else {
      pass('R:R to next structure', `≈${rMultiple.toFixed(1)}R to nearest S/R beyond entry. ✓`);
    }
  }

  return { symbol, overallPass: overallPass && !!tradeData, steps, tradeData, trend };
}

// ---------- rendering ----------
function fmtPrice(symbol, v){
  if(v==null) return '—';
  const decimals = symbol.includes('JPY') ? 3 : 5;
  return v.toFixed(decimals);
}

function renderCard(result, accountSize, riskPct){
  const card = document.createElement('div');
  card.className = 'card';

  const verdictClass = result.tradeData ? 'yes' : 'no';
  const verdictText = result.tradeData ? '✅ Trade exists' : '❌ No trade';

  let stepsHtml = result.steps.map(s=>`
    <div class="step ${s.pass?'pass':'fail'}">
      <span class="mark">${s.pass?'✓':'✕'}</span>
      <span><span class="label">${s.label}.</span> <span class="detail">${s.detail}</span></span>
    </div>`).join('');

  let tradeHtml = '';
  if(result.tradeData){
    const t = result.tradeData;
    let posSizing = '';
    if(accountSize && riskPct){
      const riskAmt = accountSize * (riskPct/100);
      const pipSize = result.symbol.includes('JPY') ? 0.01 : 0.0001;
      const stopPips = Math.abs(t.entry - t.stop) / pipSize;
      const pipValuePerStdLot = result.symbol.includes('JPY') ? 9.1 : 10; // approximation, USD-quoted
      const units = stopPips>0 ? (riskAmt / (stopPips * (pipValuePerStdLot/100000))) : 0;
      posSizing = `
        <div class="row2"><span class="k">Risk amount</span><span class="v">${riskAmt.toFixed(2)} (acct ccy)</span></div>
        <div class="row2"><span class="k">Stop distance</span><span class="v">${stopPips.toFixed(0)} pips</span></div>
        <div class="row2"><span class="k">Approx. position size</span><span class="v">${Math.round(units).toLocaleString()} units</span></div>`;
    }
    tradeHtml = `
      <div class="trade-summary">
        <div class="row2"><span class="k">Direction</span><span class="v">${t.direction}</span></div>
        <div class="row2"><span class="k">Setup</span><span class="v">${t.setupType}</span></div>
        <div class="row2"><span class="k">Stop basis</span><span class="v">${t.stopNote}</span></div>
        <div class="row2"><span class="k">Entry (approx)</span><span class="v">${fmtPrice(result.symbol, t.entry)}</span></div>
        <div class="row2"><span class="k">Stop (beyond trendline)</span><span class="v">${fmtPrice(result.symbol, t.stop)}</span></div>
        <div class="row2"><span class="k">Target (next structure)</span><span class="v">${fmtPrice(result.symbol, t.target)}</span></div>
        <div class="row2"><span class="k">R potential</span><span class="v">${t.rMultiple.toFixed(1)}R</span></div>
        ${posSizing}
      </div>
      <div class="manual-block">
        <div class="panel-title">Your judgment calls</div>
        <div class="checklist">
          <label><input type="checkbox" data-pair="${result.symbol}" data-check="news"> No high-impact news for ${result.symbol.split('/')[0]} or ${result.symbol.split('/')[1]} in the next 1–2h (check <a class="helper-link" href="https://www.forexfactory.com/calendar" target="_blank" rel="noopener">ForexFactory calendar</a>)</label>
          <label><input type="checkbox" data-pair="${result.symbol}" data-check="forced"> Setup looks clean on the chart, not forced or zoomed-in to find</label>
          <label><input type="checkbox" data-pair="${result.symbol}" data-check="weekend"> Not late Friday with stop still far from price</label>
        </div>
      </div>
    `;
  }

  card.innerHTML = `
    <div class="card-head">
      <span class="pair">${result.symbol}</span>
      <span class="verdict ${verdictClass}">${verdictText}</span>
    </div>
    <div class="card-body">
      <div class="steps">${stepsHtml}</div>
      ${tradeHtml}
    </div>
  `;
  return card;
}

// ---------- main scan ----------
scanBtn.addEventListener('click', async ()=>{
  const apiKey = apiKeyInput.value.trim();
  if(!apiKey){ scanStatus.textContent='Add your Twelve Data API key first.'; scanStatus.className='status-line err'; return; }
  const accountSize = parseFloat(document.getElementById('accountSize').value) || null;
  const riskPct = parseFloat(document.getElementById('riskPct').value) || null;

  scanBtn.disabled = true;
  resultsEl.innerHTML = '<div class="loading">Pulling H4 candles and checking structure…</div>';
  scanStatus.textContent = '';

  const cards = [];
  for(const symbol of PAIRS){
    try{
      const candles = await fetchCandles(symbol, apiKey);
      const result = analyzePair(symbol, candles);
      cards.push(renderCard(result, accountSize, riskPct));
    }catch(e){
      const errCard = document.createElement('div');
      errCard.className = 'card';
      errCard.innerHTML = `<div class="card-head"><span class="pair">${symbol}</span><span class="verdict pending">⚠ error</span></div><div class="err-box">${e.message}</div>`;
      cards.push(errCard);
    }
    // gentle spacing to respect free-tier rate limit (8/min)
    await new Promise(r=>setTimeout(r, 900));
  }

  resultsEl.innerHTML = '';
  cards.forEach(c=>resultsEl.appendChild(c));
  scanBtn.disabled = false;
  scanStatus.textContent = `Scan complete — ${new Date().toLocaleString()}`;
  scanStatus.className = 'status-line ok';
});
</script>
</body>
</html>
