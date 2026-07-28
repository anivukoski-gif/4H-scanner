const https = require('https');
const fs = require('fs');

const PAIRS = ["EUR/USD","GBP/USD","USD/JPY","EUR/JPY","GBP/JPY"];
const API_KEY = process.env.TWELVEDATA_KEY;
const MAX_HOLD = 60;   // ~10 trading days on H4
const COOLDOWN = 15;   // candles between trades on same pair

function get(url){
  return new Promise((resolve,reject)=>{
    https.get(url,res=>{let data='';res.on('data',d=>data+=d);res.on('end',()=>{try{resolve(JSON.parse(data));}catch(e){reject(e);}});}).on('error',reject);
  });
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

// ── Shared analysis logic (Tori Trades A+ — calibrated) ─────────────────────

function calcATR(candles, period) {
  const trs=[];
  for(let i=1;i<candles.length;i++){
    const c=candles[i],p=candles[i-1];
    trs.push(Math.max(c.h-c.l,Math.abs(c.h-p.c),Math.abs(c.l-p.c)));
  }
  const out=[];
  for(let i=0;i<trs.length;i++){
    const sl=trs.slice(Math.max(0,i-period+1),i+1);
    out.push(sl.reduce((a,b)=>a+b,0)/sl.length);
  }
  return out;
}

function findPivots(candles,lookback=3){
  const highs=[],lows=[];
  for(let i=lookback;i<candles.length-lookback;i++){
    const w=candles.slice(i-lookback,i+lookback+1),c=candles[i];
    if(c.h===Math.max(...w.map(x=>x.h)))highs.push({i,price:c.h});
    if(c.l===Math.min(...w.map(x=>x.l)))lows.push({i,price:c.l});
  }
  return{highs,lows};
}

function linReg(pts){
  const n=pts.length,sx=pts.reduce((a,p)=>a+p.i,0),sy=pts.reduce((a,p)=>a+p.price,0);
  const sxy=pts.reduce((a,p)=>a+p.i*p.price,0),sxx=pts.reduce((a,p)=>a+p.i*p.i,0);
  const slope=(n*sxy-sx*sy)/(n*sxx-sx*sx||1);
  return{slope,intercept:(sy-slope*sx)/n};
}

// 2–3 clean taps with minimum spacing between each
function findValidTaps(pts,minSpacing=4,minTaps=2,maxTaps=3){
  const taps=[];
  for(let i=pts.length-1;i>=0;i--){
    if(taps.length===0){taps.unshift(pts[i]);}
    else if(taps[0].i-pts[i].i>=minSpacing){taps.unshift(pts[i]);}
    if(taps.length>=maxTaps)break;
  }
  return taps.length>=minTaps?taps:null;
}

// Moderate slope — not flat, not steep (visual <45°)
function slopeOk(slope,atr){
  const a=Math.abs(slope);
  return a>atr*0.02&&a<atr*0.6;
}

// Count how many times price crossed back through the trendline
function countPriorBreaks(candles,tl,trend){
  let breaks=0,wasBelow=false,init=false;
  const from=Math.max(0,candles.length-80);
  for(let i=from;i<candles.length-1;i++){
    const lv=tl.slope*i+tl.intercept;
    const beyond=trend==='up'?candles[i].c>lv:candles[i].c<lv;
    if(!init){wasBelow=!beyond;init=true;continue;}
    if(beyond&&wasBelow){breaks++;wasBelow=false;}
    else if(!beyond){wasBelow=true;}
  }
  return breaks;
}

// Detect liquidity sweep
function detectSweep(candles,highs,lows,trend){
  if(trend==='up'&&lows.length>=2){
    const pr=lows[lows.length-2];
    return candles.slice(Math.max(0,pr.i+1),pr.i+10).some(c=>c.l<pr.price&&c.c>pr.price);
  }
  if(trend==='down'&&highs.length>=2){
    const pr=highs[highs.length-2];
    return candles.slice(Math.max(0,pr.i+1),pr.i+10).some(c=>c.h>pr.price&&c.c<pr.price);
  }
  return false;
}

// Core signal detection — used by both scanner and backtest
function detectSignal(candles){
  if(candles.length<60)return null;

  const atrSeries=calcATR(candles,14);
  const lastATR=atrSeries[atrSeries.length-1];
  const{highs,lows}=findPivots(candles,3);

  // STEP 1: Clear trend — HH/HL or LH/LL
  let trend=null;
  if(highs.length>=2&&lows.length>=2){
    const h1=highs[highs.length-2],h2=highs[highs.length-1];
    const l1=lows[lows.length-2],l2=lows[lows.length-1];
    if(h2.price>h1.price&&l2.price>l1.price)trend='up';
    else if(h2.price<h1.price&&l2.price<l1.price)trend='down';
  }
  if(!trend)return null;

  // STEP 2: Trendline — 2–3 taps, ≥1 week, moderate slope, max 1 prior break
  const H4W=30;
  const pool=trend==='up'?lows:highs;
  const taps=findValidTaps(pool,4,2,3);
  if(!taps)return null;

  const span=taps[taps.length-1].i-taps[0].i;
  if(span<H4W)return null; // must span at least 1 week

  const trendline=linReg(taps);
  if(!slopeOk(Math.abs(trendline.slope),lastATR))return null;

  const priorBreaks=countPriorBreaks(candles,trendline,trend);
  if(priorBreaks>1)return null; // max 1 failed break

  // STEP 3: Price close to trendline (compression zone)
  const li=candles.length-1;
  const lineVal=trendline.slope*li+trendline.intercept;
  const distToLine=Math.abs(candles[li].c-lineVal);
  if(distToLine>lastATR*1.5)return null; // price must be near the line

  // STEP 4: Strong body close beyond trendline
  const last=candles[candles.length-1];
  const tlv=trendline.slope*(candles.length-1)+trendline.intercept;
  const body=Math.abs(last.c-last.o),range=last.h-last.l||1e-9;
  const bodyRatio=body/range;
  const beyond=trend==='up'?last.c>tlv:last.c<tlv;
  if(!beyond||bodyRatio<=0.55)return null;

  // STEP 5: Stop, target, R:R
  const entry=last.c;
  const oppPool=trend==='up'?highs:lows;
  const oppTaps=findValidTaps(oppPool,4,2,3)||oppPool.slice(-2);
  const safetyLine=oppTaps&&oppTaps.length>=2?linReg(oppTaps):null;

  let stop,stopNote;
  if(safetyLine){
    const sv=safetyLine.slope*(li+4)+safetyLine.intercept;
    const valid=trend==='up'?sv<entry:sv>entry;
    stop=valid?sv:(trend==='up'?tlv-lastATR*0.5:tlv+lastATR*0.5);
    stopNote=valid?'Safety line (opposing trendline) at 4th candle':'ATR fallback';
  }else{
    stop=trend==='up'?tlv-lastATR*0.5:tlv+lastATR*0.5;
    stopNote='ATR-based stop beyond trendline';
  }

  const riskDist=Math.abs(entry-stop);
  if(riskDist===0)return null;

  let target;
  if(trend==='up'){const fh=highs.filter(h=>h.price>entry);target=fh.length?Math.min(...fh.map(h=>h.price)):entry+riskDist*2.5;}
  else{const fl=lows.filter(l=>l.price<entry);target=fl.length?Math.max(...fl.map(l=>l.price)):entry-riskDist*2.5;}

  const rMultiple=Math.abs(target-entry)/riskDist;
  if(rMultiple<2)return null;

  const sweep=detectSweep(candles,highs,lows,trend);

  return{
    trend,
    direction:trend==='up'?'Long':'Short',
    entry,stop,target,rMultiple,riskDist,
    taps:taps.length,
    spanWeeks:(span/H4W).toFixed(1),
    priorBreaks,
    bodyRatio:(bodyRatio*100).toFixed(0),
    sweep,stopNote
  };
}

function backtestPair(symbol,candles){
  const trades=[];let cooldown=0;
  for(let i=80;i<candles.length-MAX_HOLD;i++){
    if(cooldown>0){cooldown--;continue;}
    const sig=detectSignal(candles.slice(0,i+1));
    if(!sig)continue;
    const{direction,entry,stop,target,rMultiple,riskDist}=sig;
    let outcome='timeout',actualR=0,exitCandle=i;
    for(let j=i+1;j<=i+MAX_HOLD&&j<candles.length;j++){
      const c=candles[j];
      if(direction==='Long'){
        if(c.l<=stop){outcome='loss';actualR=-1;exitCandle=j;break;}
        if(c.h>=target){outcome='win';actualR=rMultiple;exitCandle=j;break;}
      }else{
        if(c.h>=stop){outcome='loss';actualR=-1;exitCandle=j;break;}
        if(c.l<=target){outcome='win';actualR=rMultiple;exitCandle=j;break;}
      }
    }
    if(outcome==='timeout'){
      const ep=candles[Math.min(i+MAX_HOLD,candles.length-1)].c;
      actualR=(direction==='Long'?ep-entry:entry-ep)/riskDist;
      exitCandle=Math.min(i+MAX_HOLD,candles.length-1);
    }
    trades.push({symbol,direction,outcome,actualR:parseFloat(actualR.toFixed(2)),
      entryDate:new Date(candles[i].t).toISOString().split('T')[0],
      exitDate:new Date(candles[exitCandle].t).toISOString().split('T')[0],
      rMultiple:parseFloat(rMultiple.toFixed(2))});
    cooldown=COOLDOWN;
  }
  return trades;
}

function calcStats(trades){
  if(!trades.length)return null;
  const wins=trades.filter(t=>t.outcome==='win');
  const losses=trades.filter(t=>t.outcome==='loss');
  const timeouts=trades.filter(t=>t.outcome==='timeout');
  const totalR=trades.reduce((a,t)=>a+t.actualR,0);
  let peak=0,maxDD=0,running=0,maxCL=0,cl=0;
  const equity=[0];
  for(const t of trades){
    running+=t.actualR;equity.push(parseFloat(running.toFixed(2)));
    if(running>peak)peak=running;
    const dd=peak-running;if(dd>maxDD)maxDD=dd;
    if(t.actualR<0){cl++;maxCL=Math.max(maxCL,cl);}else cl=0;
  }
  return{total:trades.length,wins:wins.length,losses:losses.length,timeouts:timeouts.length,
    winRate:(wins.length/trades.length*100).toFixed(1),
    totalR:totalR.toFixed(2),avgR:(totalR/trades.length).toFixed(2),
    avgWin:wins.length?(wins.reduce((a,t)=>a+t.actualR,0)/wins.length).toFixed(2):'N/A',
    avgLoss:losses.length?(losses.reduce((a,t)=>a+t.actualR,0)/losses.length).toFixed(2):'N/A',
    maxDD:maxDD.toFixed(2),maxCL,equity};
}

async function fetchCandles(symbol){
  const url='https://api.twelvedata.com/time_series?symbol='+encodeURIComponent(symbol)+'&interval=4h&outputsize=5000&apikey='+API_KEY;
  const data=await get(url);
  if(data.status==='error'||!data.values)throw new Error(data.message||'No data');
  return data.values.map(v=>({t:new Date(v.datetime).getTime(),o:parseFloat(v.open),h:parseFloat(v.high),l:parseFloat(v.low),c:parseFloat(v.close)})).reverse();
}

async function main(){
  const results=[];const allTrades=[];
  for(const symbol of PAIRS){
    console.log('Processing '+symbol+'...');
    try{
      const candles=await fetchCandles(symbol);
      const startDate=new Date(candles[0].t).toISOString().split('T')[0];
      const endDate=new Date(candles[candles.length-1].t).toISOString().split('T')[0];
      const trades=backtestPair(symbol,candles);
      const stats=calcStats(trades);
      allTrades.push(...trades);
      results.push({symbol,startDate,endDate,candles:candles.length,trades,stats});
      console.log('  '+symbol+': '+trades.length+' trades | win='+stats?.winRate+'% | R='+stats?.totalR);
    }catch(e){
      console.log('  ERROR '+symbol+': '+e.message);
      results.push({symbol,error:e.message,trades:[],stats:null});
    }
    await sleep(1200);
  }

  const combined=calcStats(allTrades);
  let run2=0;const combEq=[0];
  for(const t of allTrades){run2+=t.actualR;combEq.push(parseFloat(run2.toFixed(2)));}
  const runDate=new Date().toISOString().replace('T',' ').slice(0,16)+' UTC';

  const html=`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Spiraled — Backtest</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Jost:wght@300;400;500&display=swap');
:root{--cream:#F4EFE6;--paper:#FBF8F2;--ink:#2E2A24;--terra:#B5654A;--sage:#5F7A52;--line:#DCD3C2;--muted:#8C8475;}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--cream);color:var(--ink);font-family:'Jost',sans-serif;font-weight:300;padding:32px 20px 80px;}
.wrap{max-width:920px;margin:0 auto;}
h1{font-family:'Cormorant Garamond',serif;font-size:32px;font-weight:600;margin-bottom:4px;}
.meta{font-size:12px;color:var(--muted);margin-bottom:28px;}
h2{font-family:'Cormorant Garamond',serif;font-size:22px;margin:32px 0 14px;}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:20px;}
.stat{background:var(--paper);border:1px solid var(--line);border-radius:2px;padding:12px 14px;}
.stat .lbl{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:5px;}
.stat .val{font-size:22px;font-family:'Cormorant Garamond',serif;font-weight:600;}
.pos{color:var(--sage);}.neg{color:var(--terra);}
.chart-box{background:var(--paper);border:1px solid var(--line);border-radius:2px;padding:18px;margin-bottom:18px;}
.chart-box canvas{max-height:200px;}
.rules{background:var(--paper);border:1px solid var(--line);padding:12px 16px;border-radius:2px;font-size:12px;color:var(--muted);line-height:1.9;margin-bottom:24px;}
.rules strong{color:var(--ink);}
table{width:100%;border-collapse:collapse;font-size:12.5px;background:var(--paper);border:1px solid var(--line);border-radius:2px;margin-bottom:6px;}
th{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);padding:9px 11px;text-align:left;border-bottom:1px solid var(--line);font-weight:400;}
td{padding:8px 11px;border-bottom:1px solid var(--line);}
tr:last-child td{border-bottom:none;}
.win{color:var(--sage);font-weight:500;}.loss{color:var(--terra);font-weight:500;}.timeout{color:var(--muted);}
.pair-section{margin-bottom:44px;}
.badge{display:inline-block;font-size:10px;letter-spacing:.07em;text-transform:uppercase;padding:2px 8px;border-radius:10px;font-weight:500;margin-left:8px;vertical-align:middle;}
.badge.pos{background:rgba(95,122,82,.12);color:var(--sage);}
.badge.neg{background:rgba(181,101,74,.12);color:var(--terra);}
.expectancy{margin:12px 0 20px;padding:14px 18px;border-radius:2px;font-size:13.5px;font-weight:500;}
.expectancy.pos{background:rgba(95,122,82,.1);border:1px solid rgba(95,122,82,.25);color:var(--sage);}
.expectancy.neg{background:rgba(181,101,74,.08);border:1px solid rgba(181,101,74,.22);color:var(--terra);}
footer{margin-top:40px;font-size:11px;color:var(--muted);text-align:center;line-height:1.8;}
</style>
</head>
<body>
<div class="wrap">
<h1>Backtest Results</h1>
<div class="meta">Spiraled H4 · Tori Trades A+ · Walk-forward, no look-ahead · ${runDate}</div>

<div class="rules">
  <strong>Rules applied:</strong> H4 trend (HH/HL or LH/LL) &nbsp;·&nbsp; 2–3 tap trendline &nbsp;·&nbsp; ≥1 week span &nbsp;·&nbsp; Moderate slope &nbsp;·&nbsp; Max 1 prior failed break &nbsp;·&nbsp; Price within 1.5×ATR of line &nbsp;·&nbsp; Body-dominant close >55% &nbsp;·&nbsp; Safety line stop &nbsp;·&nbsp; ≥2R to next structure<br>
  <strong>Visual judgment calls excluded (manual):</strong> Controlled pullbacks · Clear path to target · News filter · Liquidity sweep quality
</div>

<h2>Combined — All Pairs</h2>
${combined?`
<div class="cards">
  <div class="stat"><div class="lbl">Total trades</div><div class="val">${combined.total}</div></div>
  <div class="stat"><div class="lbl">Win rate</div><div class="val ${parseFloat(combined.winRate)>=50?'pos':'neg'}">${combined.winRate}%</div></div>
  <div class="stat"><div class="lbl">Total R</div><div class="val ${parseFloat(combined.totalR)>=0?'pos':'neg'}">${combined.totalR}R</div></div>
  <div class="stat"><div class="lbl">Avg R / trade</div><div class="val ${parseFloat(combined.avgR)>=0?'pos':'neg'}">${combined.avgR}R</div></div>
  <div class="stat"><div class="lbl">Avg win</div><div class="val pos">${combined.avgWin}R</div></div>
  <div class="stat"><div class="lbl">Avg loss</div><div class="val neg">${combined.avgLoss}R</div></div>
  <div class="stat"><div class="lbl">Max drawdown</div><div class="val neg">${combined.maxDD}R</div></div>
  <div class="stat"><div class="lbl">Max consec. L</div><div class="val">${combined.maxCL}</div></div>
</div>
<div class="expectancy ${parseFloat(combined.avgR)>=0?'pos':'neg'}">
  ${parseFloat(combined.avgR)>=0?'✅ Positive expectancy — strategy has edge over this period.':'⚠️ Negative expectancy — review rule calibration or sample size.'}
  &nbsp; Avg ${combined.avgR}R per trade across ${combined.total} signals.
</div>
<div class="chart-box"><canvas id="eqAll"></canvas></div>
`:'<p style="color:var(--muted);padding:10px 0;font-size:13px;">No trades generated.</p>'}

${results.map(r=>{
  if(r.error)return '<div class="pair-section"><h2>'+r.symbol+'</h2><p style="color:var(--terra);font-size:13px;">Error: '+r.error+'</p></div>';
  if(!r.stats)return '<div class="pair-section"><h2>'+r.symbol+'</h2><p style="color:var(--muted);font-size:13px;">No trades generated ('+r.candles+' candles · '+r.startDate+' → '+r.endDate+').</p></div>';
  const s=r.stats,tr=parseFloat(s.totalR);
  return `<div class="pair-section">
    <h2>${r.symbol}<span class="badge ${tr>=0?'pos':'neg'}">${tr>=0?'+':''}${tr}R</span></h2>
    <div style="font-size:12px;color:var(--muted);margin-bottom:12px;">${r.candles} candles · ${r.startDate} → ${r.endDate}</div>
    <div class="cards">
      <div class="stat"><div class="lbl">Trades</div><div class="val">${s.total}</div></div>
      <div class="stat"><div class="lbl">Win rate</div><div class="val ${parseFloat(s.winRate)>=50?'pos':'neg'}">${s.winRate}%</div></div>
      <div class="stat"><div class="lbl">Total R</div><div class="val ${tr>=0?'pos':'neg'}">${s.totalR}R</div></div>
      <div class="stat"><div class="lbl">Avg R</div><div class="val ${parseFloat(s.avgR)>=0?'pos':'neg'}">${s.avgR}R</div></div>
      <div class="stat"><div class="lbl">Max DD</div><div class="val neg">${s.maxDD}R</div></div>
      <div class="stat"><div class="lbl">Consec. L</div><div class="val">${s.maxCL}</div></div>
    </div>
    <div class="chart-box"><canvas id="eq_${r.symbol.replace('/','_')}"></canvas></div>
    <table>
      <thead><tr><th>Entry</th><th>Exit</th><th>Dir</th><th>Outcome</th><th>Actual R</th><th>Target R</th></tr></thead>
      <tbody>${r.trades.map(t=>`<tr>
        <td>${t.entryDate}</td><td>${t.exitDate}</td><td>${t.direction}</td>
        <td class="${t.outcome}">${t.outcome==='win'?'✓ Win':t.outcome==='loss'?'✗ Loss':'~ Timeout'}</td>
        <td class="${t.actualR>=0?'win':'loss'}">${t.actualR>0?'+':''}${t.actualR}R</td>
        <td>${t.rMultiple}R</td>
      </tr>`).join('')}</tbody>
    </table>
  </div>`;
}).join('')}

<footer>Walk-forward backtest — signal detection uses only data available at each entry point in time.<br>Past results do not guarantee future performance. Always verify setups visually and check news before trading.</footer>
</div>
<script>
function drawEq(id,eq,label){
  const ctx=document.getElementById(id);if(!ctx)return;
  const final=parseFloat(eq[eq.length-1]);
  new Chart(ctx,{type:'line',data:{
    labels:eq.map((_,i)=>i===0?'Start':'#'+i),
    datasets:[{label,data:eq,borderColor:final>=0?'#5F7A52':'#B5654A',borderWidth:2,
      pointRadius:eq.length>60?0:3,fill:true,
      backgroundColor:final>=0?'rgba(95,122,82,0.07)':'rgba(181,101,74,0.07)',tension:0.3}]
  },options:{responsive:true,
    plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>c.parsed.y.toFixed(2)+'R'}}},
    scales:{x:{display:false},y:{grid:{color:'rgba(0,0,0,0.04)'},ticks:{callback:v=>v+'R',font:{family:'Jost',size:11}}}}}
  });
}
${combined?'drawEq(\'eqAll\','+JSON.stringify(combEq)+',' +"'All pairs');":""}
${results.filter(r=>r.stats).map(r=>'drawEq(\'eq_'+r.symbol.replace('/','_')+'\',' +JSON.stringify(r.stats.equity)+',' +"'"+r.symbol+"');").join('\n')}
<\/script>
</body></html>`;

  fs.writeFileSync('backtest.html',html);
  console.log('\nDone — results written to backtest.html');
}

main();
