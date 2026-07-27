const https = require('https');
const fs = require('fs');

const PAIRS = ["EUR/USD","GBP/USD","USD/JPY","EUR/JPY","GBP/JPY"];
const API_KEY = process.env.TWELVEDATA_KEY;
const MAX_HOLD_CANDLES = 60; // ~10 trading days
const COOLDOWN_CANDLES = 15;

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data='';
      res.on('data', d=>data+=d);
      res.on('end', ()=>{ try{resolve(JSON.parse(data));}catch(e){reject(e);} });
    }).on('error', reject);
  });
}
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

function calcATR(candles, period) {
  const trs=[];
  for (let i=1;i<candles.length;i++) {
    const c=candles[i],p=candles[i-1];
    trs.push(Math.max(c.h-c.l,Math.abs(c.h-p.c),Math.abs(c.l-p.c)));
  }
  const out=[];
  for (let i=0;i<trs.length;i++) {
    const sl=trs.slice(Math.max(0,i-period+1),i+1);
    out.push(sl.reduce((a,b)=>a+b,0)/sl.length);
  }
  return out;
}

function findPivots(candles, lookback=3) {
  const highs=[],lows=[];
  for (let i=lookback;i<candles.length-lookback;i++) {
    const w=candles.slice(i-lookback,i+lookback+1),c=candles[i];
    if (c.h===Math.max(...w.map(x=>x.h))) highs.push({i,price:c.h});
    if (c.l===Math.min(...w.map(x=>x.l))) lows.push({i,price:c.l});
  }
  return{highs,lows};
}

function linReg(pts) {
  const n=pts.length;
  const sx=pts.reduce((a,p)=>a+p.i,0),sy=pts.reduce((a,p)=>a+p.price,0);
  const sxy=pts.reduce((a,p)=>a+p.i*p.price,0),sxx=pts.reduce((a,p)=>a+p.i*p.i,0);
  const slope=(n*sxy-sx*sy)/(n*sxx-sx*sx||1);
  return{slope,intercept:(sy-slope*sx)/n};
}

function findValidTaps(pts, minSpacing=4, minTaps=2, maxTaps=3) {
  const taps=[];
  for (let i=pts.length-1;i>=0;i--) {
    if (taps.length===0){taps.unshift(pts[i]);}
    else if (taps[0].i-pts[i].i>=minSpacing){taps.unshift(pts[i]);}
    if (taps.length>=maxTaps) break;
  }
  return taps.length>=minTaps?taps:null;
}

function slopeOk(slope,atr){const a=Math.abs(slope);return a>atr*0.03&&a<atr*0.5;}

function countPriorBreaks(candles,tl,trend) {
  let breaks=0,wasBelow=false,init=false;
  const from=Math.max(0,candles.length-60);
  for (let i=from;i<candles.length-1;i++) {
    const lv=tl.slope*i+tl.intercept;
    const beyond=trend==='up'?candles[i].c>lv:candles[i].c<lv;
    if(!init){wasBelow=!beyond;init=true;continue;}
    if(beyond&&wasBelow){breaks++;wasBelow=false;}
    else if(!beyond){wasBelow=true;}
  }
  return breaks;
}

function pullbacksControlled(candles,highs,lows,trend) {
  if(highs.length<2||lows.length<2) return false;
  const swings=trend==='up'?lows.slice(-2).map(l=>l.i):highs.slice(-2).map(h=>h.i);
  if(swings.length<2) return true;
  const pb=candles.slice(swings[0],swings[1]+1);
  const avgPB=pb.reduce((a,c)=>a+(c.h-c.l),0)/(pb.length||1);
  const avgATR=candles.slice(-20).reduce((a,c)=>a+(c.h-c.l),0)/20;
  return avgPB<avgATR*1.5;
}

function clearPathToTarget(entry,target,highs,lows,trend) {
  const obs=trend==='up'
    ?highs.filter(h=>h.price>entry&&h.price<target)
    :lows.filter(l=>l.price<entry&&l.price>target);
  return obs.length<=1;
}

function detectSignal(candles) {
  if(candles.length<60) return null;
  const atrSeries=calcATR(candles,14);
  const lastATR=atrSeries[atrSeries.length-1];
  const{highs,lows}=findPivots(candles,3);

  let trend=null;
  if(highs.length>=2&&lows.length>=2){
    const h1=highs[highs.length-2],h2=highs[highs.length-1];
    const l1=lows[lows.length-2],l2=lows[lows.length-1];
    if(h2.price>h1.price&&l2.price>l1.price) trend='up';
    else if(h2.price<h1.price&&l2.price<l1.price) trend='down';
  }
  if(!trend) return null;
  if(!pullbacksControlled(candles,highs,lows,trend)) return null;

  const H4W=30;
  const pool=trend==='up'?lows:highs;
  const taps=findValidTaps(pool,4,2,3);
  if(!taps) return null;

  const span=taps[taps.length-1].i-taps[0].i;
  if(span<H4W) return null;

  const trendline=linReg(taps);
  if(!slopeOk(Math.abs(trendline.slope),lastATR)) return null;

  const priorBreaks=countPriorBreaks(candles,trendline,trend);
  if(priorBreaks>1) return null;

  // Compression
  const li=candles.length-1;
  const lv=trendline.slope*li+trendline.intercept;
  const dist=Math.abs(candles[li].c-lv);
  if(dist>lastATR*1.2) return null;
  const recentR=candles.slice(-5).map(c=>c.h-c.l);
  const priorR=candles.slice(-15,-5).map(c=>c.h-c.l);
  const avgR=recentR.reduce((a,b)=>a+b,0)/recentR.length;
  const avgP=priorR.reduce((a,b)=>a+b,0)/priorR.length;
  if(avgR>=avgP*0.98) return null;

  // Break
  const last=candles[candles.length-1];
  const tlv=trendline.slope*(candles.length-1)+trendline.intercept;
  const body=Math.abs(last.c-last.o);
  const range=last.h-last.l||1e-9;
  const beyond=trend==='up'?last.c>tlv:last.c<tlv;
  if(!beyond||body/range<=0.55) return null;

  const entry=last.c;
  const oppPool=trend==='up'?highs:lows;
  const oppTaps=findValidTaps(oppPool,4,2,3)||oppPool.slice(-2);
  const safetyLine=oppTaps&&oppTaps.length>=2?linReg(oppTaps):null;
  let stop;
  if(safetyLine){
    const sv=safetyLine.slope*(li+4)+safetyLine.intercept;
    const valid=trend==='up'?sv<entry:sv>entry;
    stop=valid?sv:(trend==='up'?tlv-lastATR*0.5:tlv+lastATR*0.5);
  } else {
    stop=trend==='up'?tlv-lastATR*0.5:tlv+lastATR*0.5;
  }

  const riskDist=Math.abs(entry-stop);
  if(riskDist===0) return null;

  let target;
  if(trend==='up'){const fh=highs.filter(h=>h.price>entry);target=fh.length?Math.min(...fh.map(h=>h.price)):entry+riskDist*2.5;}
  else{const fl=lows.filter(l=>l.price<entry);target=fl.length?Math.max(...fl.map(l=>l.price)):entry-riskDist*2.5;}

  const rMultiple=Math.abs(target-entry)/riskDist;
  if(rMultiple<2) return null;
  if(!clearPathToTarget(entry,target,highs,lows,trend)) return null;

  return{trend,direction:trend==='up'?'Long':'Short',entry,stop,target,rMultiple,riskDist};
}

function backtestPair(symbol,candles) {
  const trades=[];
  let cooldown=0;
  for(let i=80;i<candles.length-MAX_HOLD_CANDLES;i++){
    if(cooldown>0){cooldown--;continue;}
    const signal=detectSignal(candles.slice(0,i+1));
    if(!signal) continue;
    const{direction,entry,stop,target,rMultiple,riskDist}=signal;
    let outcome='timeout',actualR=0,exitCandle=i;
    for(let j=i+1;j<=i+MAX_HOLD_CANDLES&&j<candles.length;j++){
      const c=candles[j];
      if(direction==='Long'){
        if(c.l<=stop){outcome='loss';actualR=-1;exitCandle=j;break;}
        if(c.h>=target){outcome='win';actualR=rMultiple;exitCandle=j;break;}
        // Exit if trendline reclaimed (Step 6)
      } else {
        if(c.h>=stop){outcome='loss';actualR=-1;exitCandle=j;break;}
        if(c.l<=target){outcome='win';actualR=rMultiple;exitCandle=j;break;}
      }
    }
    if(outcome==='timeout'){
      const ep=candles[Math.min(i+MAX_HOLD_CANDLES,candles.length-1)].c;
      actualR=(direction==='Long'?ep-entry:entry-ep)/riskDist;
      exitCandle=Math.min(i+MAX_HOLD_CANDLES,candles.length-1);
    }
    trades.push({
      symbol,direction,outcome,
      actualR:parseFloat(actualR.toFixed(2)),
      entryDate:new Date(candles[i].t).toISOString().split('T')[0],
      exitDate:new Date(candles[exitCandle].t).toISOString().split('T')[0],
      rMultiple:parseFloat(rMultiple.toFixed(2))
    });
    cooldown=COOLDOWN_CANDLES;
  }
  return trades;
}

function calcStats(trades) {
  if(!trades.length) return null;
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
  return{
    total:trades.length,wins:wins.length,losses:losses.length,timeouts:timeouts.length,
    winRate:(wins.length/trades.length*100).toFixed(1),
    totalR:totalR.toFixed(2),avgR:(totalR/trades.length).toFixed(2),
    avgWin:wins.length?(wins.reduce((a,t)=>a+t.actualR,0)/wins.length).toFixed(2):'N/A',
    avgLoss:losses.length?(losses.reduce((a,t)=>a+t.actualR,0)/losses.length).toFixed(2):'N/A',
    maxDD:maxDD.toFixed(2),maxCL,equity
  };
}

async function fetchCandles(symbol) {
  const url=`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=4h&outputsize=5000&apikey=${API_KEY}`;
  const data=await get(url);
  if(data.status==='error'||!data.values) throw new Error(data.message||'No data');
  return data.values.map(v=>({
    t:new Date(v.datetime).getTime(),
    o:parseFloat(v.open),h:parseFloat(v.high),l:parseFloat(v.low),c:parseFloat(v.close)
  })).reverse();
}

async function main() {
  const results=[];
  const allTrades=[];
  for(const symbol of PAIRS){
    console.log(`Processing ${symbol}...`);
    try{
      const candles=await fetchCandles(symbol);
      const startDate=new Date(candles[0].t).toISOString().split('T')[0];
      const endDate=new Date(candles[candles.length-1].t).toISOString().split('T')[0];
      const trades=backtestPair(symbol,candles);
      const stats=calcStats(trades);
      allTrades.push(...trades);
      results.push({symbol,startDate,endDate,candles:candles.length,trades,stats});
      console.log(`  ${symbol}: ${trades.length} trades | winRate=${stats?.winRate}% | totalR=${stats?.totalR}`);
    }catch(e){
      console.log(`  ERROR ${symbol}: ${e.message}`);
      results.push({symbol,error:e.message,trades:[],stats:null});
    }
    await sleep(1200);
  }

  const combinedStats=calcStats(allTrades);
  let running=0;
  const combinedEquity=[0];
  for(const t of allTrades){running+=t.actualR;combinedEquity.push(parseFloat(running.toFixed(2)));}
  const runDate=new Date().toISOString().replace('T',' ').slice(0,16)+' UTC';

  const html=`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Spiraled — Backtest Results</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Jost:wght@300;400;500&display=swap');
  :root{--cream:#F4EFE6;--paper:#FBF8F2;--ink:#2E2A24;--terra:#B5654A;--sage:#5F7A52;--line:#DCD3C2;--muted:#8C8475;}
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:var(--cream);color:var(--ink);font-family:'Jost',sans-serif;font-weight:300;padding:32px 20px 80px;}
  .wrap{max-width:900px;margin:0 auto;}
  h1{font-family:'Cormorant Garamond',serif;font-size:32px;font-weight:600;margin-bottom:4px;}
  .meta{font-size:12px;color:var(--muted);margin-bottom:32px;letter-spacing:.04em;}
  h2{font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:500;margin:32px 0 14px;}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:24px;}
  .stat{background:var(--paper);border:1px solid var(--line);border-radius:2px;padding:14px 16px;}
  .stat .label{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:6px;}
  .stat .value{font-size:24px;font-family:'Cormorant Garamond',serif;font-weight:600;}
  .stat .value.pos{color:var(--sage);}
  .stat .value.neg{color:var(--terra);}
  .chart-wrap{background:var(--paper);border:1px solid var(--line);border-radius:2px;padding:20px;margin-bottom:20px;}
  .chart-wrap canvas{max-height:220px;}
  table{width:100%;border-collapse:collapse;font-size:13px;background:var(--paper);border:1px solid var(--line);border-radius:2px;overflow:hidden;margin-bottom:8px;}
  th{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);font-weight:400;}
  td{padding:9px 12px;border-bottom:1px solid var(--line);}
  tr:last-child td{border-bottom:none;}
  .win{color:var(--sage);font-weight:500;}
  .loss{color:var(--terra);font-weight:500;}
  .timeout{color:var(--muted);}
  .pair-section{margin-bottom:48px;}
  .tag{display:inline-block;font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:3px 9px;border-radius:10px;font-weight:500;margin-left:8px;vertical-align:middle;}
  .tag.pos{background:rgba(95,122,82,.12);color:var(--sage);}
  .tag.neg{background:rgba(181,101,74,.12);color:var(--terra);}
  .rules{background:var(--paper);border:1px solid var(--line);border-radius:2px;padding:14px 18px;margin-bottom:28px;font-size:12.5px;color:var(--muted);line-height:1.8;}
  .rules strong{color:var(--ink);font-weight:500;}
  footer{margin-top:40px;font-size:11px;color:var(--muted);text-align:center;line-height:1.8;}
</style>
</head>
<body>
<div class="wrap">
  <h1>Backtest Results</h1>
  <div class="meta">Spiraled H4 · Tori Trades A+ Strategy · Walk-forward, no look-ahead · ${runDate}</div>

  <div class="rules">
    <strong>Rules applied:</strong> H4 trend (HH/HL or LH/LL) · Controlled pullbacks · 2–3 tap trendline · Moderate slope · ≥1 week span · Max 1 prior failed break · Candle compression · Strong body break (>55%) · Safety line stop · 2R+ to next S/R · Clear path to target
  </div>

  <h2>Combined — All Pairs</h2>
  ${combinedStats?`
  <div class="cards">
    <div class="stat"><div class="label">Total trades</div><div class="value">${combinedStats.total}</div></div>
    <div class="stat"><div class="label">Win rate</div><div class="value ${parseFloat(combinedStats.winRate)>=50?'pos':'neg'}">${combinedStats.winRate}%</div></div>
    <div class="stat"><div class="label">Total R</div><div class="value ${parseFloat(combinedStats.totalR)>=0?'pos':'neg'}">${combinedStats.totalR}R</div></div>
    <div class="stat"><div class="label">Avg R / trade</div><div class="value ${parseFloat(combinedStats.avgR)>=0?'pos':'neg'}">${combinedStats.avgR}R</div></div>
    <div class="stat"><div class="label">Avg win</div><div class="value pos">${combinedStats.avgWin}R</div></div>
    <div class="stat"><div class="label">Avg loss</div><div class="value neg">${combinedStats.avgLoss}R</div></div>
    <div class="stat"><div class="label">Max drawdown</div><div class="value neg">${combinedStats.maxDD}R</div></div>
    <div class="stat"><div class="label">Max consec. losses</div><div class="value">${combinedStats.maxCL}</div></div>
  </div>
  <div class="chart-wrap">
    <canvas id="equityCombined"></canvas>
  </div>`:'<p style="color:var(--muted);font-size:13px;padding:12px 0;">No trades generated across all pairs.</p>'}

  ${results.map(r=>{
    if(r.error) return `<div class="pair-section"><h2>${r.symbol}</h2><p style="color:var(--terra);font-size:13px;">Error: ${r.error}</p></div>`;
    if(!r.stats) return `<div class="pair-section"><h2>${r.symbol}</h2><p style="color:var(--muted);font-size:13px;">No trades generated (${r.candles} candles · ${r.startDate} → ${r.endDate}).</p></div>`;
    const s=r.stats;
    const tr=parseFloat(s.totalR);
    return`<div class="pair-section">
      <h2>${r.symbol}<span class="tag ${tr>=0?'pos':'neg'}">${tr>=0?'+':''}${tr}R</span></h2>
      <div style="font-size:12px;color:var(--muted);margin-bottom:14px;">${r.candles} candles · ${r.startDate} → ${r.endDate}</div>
      <div class="cards">
        <div class="stat"><div class="label">Trades</div><div class="value">${s.total}</div></div>
        <div class="stat"><div class="label">Win rate</div><div class="value ${parseFloat(s.winRate)>=50?'pos':'neg'}">${s.winRate}%</div></div>
        <div class="stat"><div class="label">Total R</div><div class="value ${tr>=0?'pos':'neg'}">${s.totalR}R</div></div>
        <div class="stat"><div class="label">Avg R</div><div class="value ${parseFloat(s.avgR)>=0?'pos':'neg'}">${s.avgR}R</div></div>
        <div class="stat"><div class="label">Max DD</div><div class="value neg">${s.maxDD}R</div></div>
        <div class="stat"><div class="label">Max consec. L</div><div class="value">${s.maxCL}</div></div>
      </div>
      <div class="chart-wrap"><canvas id="equity_${r.symbol.replace('/','_')}"></canvas></div>
      <table>
        <thead><tr><th>Entry date</th><th>Exit date</th><th>Direction</th><th>Outcome</th><th>Actual R</th><th>Target R</th></tr></thead>
        <tbody>${r.trades.map(t=>`<tr>
          <td>${t.entryDate}</td><td>${t.exitDate}</td><td>${t.direction}</td>
          <td class="${t.outcome}">${t.outcome==='win'?'✓ Win':t.outcome==='loss'?'✗ Loss':'~ Timeout'}</td>
          <td class="${t.actualR>=0?'win':'loss'}">${t.actualR>0?'+':''}${t.actualR}R</td>
          <td>${t.rMultiple}R</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
  }).join('')}

  <footer>Walk-forward backtest — only data available at entry time used per signal.<br>Past results do not guarantee future performance. Always verify setups visually and check news before trading.</footer>
</div>
<script>
function drawEquity(id,equity,label){
  const ctx=document.getElementById(id);
  if(!ctx)return;
  const final=parseFloat(equity[equity.length-1]);
  new Chart(ctx,{
    type:'line',
    data:{
      labels:equity.map((_,i)=>i===0?'Start':'#'+i),
      datasets:[{
        label,data:equity,
        borderColor:final>=0?'#5F7A52':'#B5654A',
        borderWidth:2,
        pointRadius:equity.length>50?0:3,
        fill:true,
        backgroundColor:final>=0?'rgba(95,122,82,0.07)':'rgba(181,101,74,0.07)',
        tension:0.3
      }]
    },
    options:{
      responsive:true,
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>c.parsed.y.toFixed(2)+'R'}}},
      scales:{
        x:{display:false},
        y:{grid:{color:'rgba(0,0,0,0.04)'},ticks:{callback:v=>v+'R',font:{family:'Jost',size:11}}}
      }
    }
  });
}
${combinedStats?`drawEquity('equityCombined',${JSON.stringify(combinedEquity)},'All pairs');`:''}
${results.filter(r=>r.stats).map(r=>`drawEquity('equity_${r.symbol.replace('/','_')}',${JSON.stringify(r.stats.equity)},'${r.symbol}');`).join('\n')}
<\/script>
</body>
</html>`;

  fs.writeFileSync('backtest.html',html);
  console.log('\nResults written to backtest.html');
}

main();
