const https = require('https');

const PAIRS = ["EUR/USD","GBP/USD","USD/JPY","EUR/JPY","GBP/JPY"];
const API_KEY = process.env.TWELVEDATA_KEY;
const NTFY_TOPIC = process.env.NTFY_TOPIC;

function get(url){
  return new Promise((resolve,reject)=>{
    https.get(url,res=>{
      let data='';
      res.on('data',d=>data+=d);
      res.on('end',()=>resolve(JSON.parse(data)));
    }).on('error',reject);
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

function notify(title,message){
  return new Promise((resolve,reject)=>{
    const body=Buffer.from(message);
    const req=https.request({
      hostname:'ntfy.sh',path:'/'+NTFY_TOPIC,method:'POST',
      headers:{'Title':title,'Content-Type':'text/plain','Content-Length':body.length,'Priority':'high','Tags':'chart_with_upwards_trend'}
    },resolve);
    req.on('error',reject);req.write(body);req.end();
  });
}

async function main(){
  const signals=[];
  for(const symbol of PAIRS){
    try{
      const url='https://api.twelvedata.com/time_series?symbol='+encodeURIComponent(symbol)+'&interval=4h&outputsize=200&apikey='+API_KEY;
      const data=await get(url);
      if(data.status==='error'||!data.values){await sleep(900);continue;}
      const candles=data.values.map(v=>({t:new Date(v.datetime).getTime(),o:parseFloat(v.open),h:parseFloat(v.high),l:parseFloat(v.low),c:parseFloat(v.close)})).reverse();
      const result=detectSignal(candles);
      if(result)signals.push({symbol,...result});
    }catch(e){console.error('Error for '+symbol+':',e.message);}
    await sleep(900);
  }

  if(signals.length===0){console.log('No A+ signals. No notification sent.');return;}

  const dec=s=>s.includes('JPY')?3:5;
  const title='📈 '+signals.length+' A+ signal'+(signals.length>1?'s':'')+' — Spiraled H4';
  const message=signals.map(s=>
    s.symbol+' — '+s.direction+'\n'+
    s.taps+'-tap line ('+s.spanWeeks+'wks)'+( s.priorBreaks===1?' | 1 prior break':'')+'\n'+
    'Body: '+s.bodyRatio+'% | R: '+s.rMultiple.toFixed(1)+'R\n'+
    'Entry: '+s.entry.toFixed(dec(s.symbol))+' | Stop: '+s.stop.toFixed(dec(s.symbol))+' | Target: '+s.target.toFixed(dec(s.symbol))+'\n'+
    (s.sweep?'✓ Liquidity sweep detected':'⚠️ No clear sweep — check manually')+'\n'+
    '⚠️ Check news + confirm chart before entering'
  ).join('\n\n');

  await notify(title,message);
  console.log('Sent for:',signals.map(s=>s.symbol).join(', '));
}

main();
