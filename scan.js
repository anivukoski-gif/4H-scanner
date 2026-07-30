const https = require('https');

const PAIRS = ["EUR/USD","GBP/USD","USD/JPY","EUR/JPY","GBP/JPY"];
const API_KEY = process.env.TWELVEDATA_KEY;
const NTFY_TOPIC = process.env.NTFY_TOPIC;

function get(url){
  return new Promise((resolve,reject)=>{
    https.get(url,res=>{
      let data='';res.on('data',d=>data+=d);
      res.on('end',()=>resolve(JSON.parse(data)));
    }).on('error',reject);
  });
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

// ── Shared core logic — Tori Trades A+ (sequential compression → break) ──────

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

function findPivots(candles, lookback=3) {
  const highs=[],lows=[];
  for(let i=lookback;i<candles.length-lookback;i++){
    const w=candles.slice(i-lookback,i+lookback+1),c=candles[i];
    if(c.h===Math.max(...w.map(x=>x.h)))highs.push({i,price:c.h});
    if(c.l===Math.min(...w.map(x=>x.l)))lows.push({i,price:c.l});
  }
  return{highs,lows};
}

function linReg(pts) {
  const n=pts.length,sx=pts.reduce((a,p)=>a+p.i,0),sy=pts.reduce((a,p)=>a+p.price,0);
  const sxy=pts.reduce((a,p)=>a+p.i*p.price,0),sxx=pts.reduce((a,p)=>a+p.i*p.i,0);
  const slope=(n*sxy-sx*sy)/(n*sxx-sx*sx||1);
  return{slope,intercept:(sy-slope*sx)/n};
}

function findValidTaps(pts, minSpacing=4, minTaps=2, maxTaps=3) {
  const taps=[];
  for(let i=pts.length-1;i>=0;i--){
    if(taps.length===0){taps.unshift(pts[i]);}
    else if(taps[0].i-pts[i].i>=minSpacing){taps.unshift(pts[i]);}
    if(taps.length>=maxTaps)break;
  }
  return taps.length>=minTaps?taps:null;
}

function slopeOk(slope, atr) {
  const a=Math.abs(slope);
  return a>atr*0.02 && a<atr*0.6;
}

function countPriorBreaks(candles, tl, trend) {
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

function detectSweep(candles, highs, lows, trend) {
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

// Build trendline context — used by both compression check and break check
function buildTrendlineContext(candles, atrSeries) {
  if(candles.length<60) return null;
  const lastATR=atrSeries[atrSeries.length-1];
  const{highs,lows}=findPivots(candles,3);
  const H4W=30;

  // Step 1: trend
  let trend=null;
  if(highs.length>=2&&lows.length>=2){
    const h1=highs[highs.length-2],h2=highs[highs.length-1];
    const l1=lows[lows.length-2],l2=lows[lows.length-1];
    if(h2.price>h1.price&&l2.price>l1.price) trend='up';
    else if(h2.price<h1.price&&l2.price<l1.price) trend='down';
  }
  if(!trend) return null;

  // Step 2: trendline
  const pool=trend==='up'?lows:highs;
  const taps=findValidTaps(pool,4,2,3);
  if(!taps) return null;
  const span=taps[taps.length-1].i-taps[0].i;
  if(span<H4W) return null;
  const trendline=linReg(taps);
  if(!slopeOk(Math.abs(trendline.slope),lastATR)) return null;
  const priorBreaks=countPriorBreaks(candles,trendline,trend);
  if(priorBreaks>1) return null;

  return{trend,trendline,taps,span,priorBreaks,highs,lows,lastATR,H4W};
}

// PHASE A: compression — price approaching the line, setup forming
// Returns context if setup is forming (no break yet required)
function detectCompression(candles, atrSeries) {
  const ctx=buildTrendlineContext(candles,atrSeries);
  if(!ctx) return null;
  const{trend,trendline,lastATR}=ctx;
  const li=candles.length-1;
  const lv=trendline.slope*li+trendline.intercept;
  const dist=Math.abs(candles[li].c-lv);
  // Price must be within 2×ATR of line and on the correct side (not yet broken)
  const onCorrectSide=trend==='up'?candles[li].c<lv:candles[li].c>lv;
  if(!onCorrectSide) return null; // already broken — handle in phase B
  if(dist>lastATR*2) return null;
  return{...ctx,dist,compressionATRs:(dist/lastATR).toFixed(2)};
}

// PHASE B: break — a recent candle (within last 3) closed beyond the line with body dominance
// This separates compression phase from break phase
function detectBreak(candles, atrSeries) {
  const ctx=buildTrendlineContext(candles,atrSeries);
  if(!ctx) return null;
  const{trend,trendline,highs,lows,lastATR,taps,span,priorBreaks,H4W}=ctx;

  // Look back up to 3 candles for the break candle
  let breakCandle=null,breakIdx=null;
  for(let offset=0;offset<=3;offset++){
    const idx=candles.length-1-offset;
    if(idx<0) break;
    const lv=trendline.slope*idx+trendline.intercept;
    const c=candles[idx];
    const body=Math.abs(c.c-c.o),range=c.h-c.l||1e-9;
    const bodyRatio=body/range;
    const beyond=trend==='up'?c.c>lv:c.c<lv;
    if(beyond&&bodyRatio>0.55){
      // Also check the candle BEFORE was on the correct side (confirms it's a fresh break)
      if(idx>0){
        const prevLv=trendline.slope*(idx-1)+trendline.intercept;
        const prevOnSide=trend==='up'?candles[idx-1].c<prevLv:candles[idx-1].c>prevLv;
        if(prevOnSide){breakCandle=c;breakIdx=idx;break;}
      }
    }
  }
  if(!breakCandle) return null;

  // Compute stop & target from break candle
  const entry=breakCandle.c;
  const li=breakIdx;
  const tlv=trendline.slope*li+trendline.intercept;
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
  if(riskDist===0) return null;

  let target;
  if(trend==='up'){const fh=highs.filter(h=>h.price>entry);target=fh.length?Math.min(...fh.map(h=>h.price)):entry+riskDist*2.5;}
  else{const fl=lows.filter(l=>l.price<entry);target=fl.length?Math.max(...fl.map(l=>l.price)):entry-riskDist*2.5;}

  const rMultiple=Math.abs(target-entry)/riskDist;
  if(rMultiple<2) return null;

  const sweep=detectSweep(candles,highs,lows,trend);
  const bodyRatio=(Math.abs(breakCandle.c-breakCandle.o)/(breakCandle.h-breakCandle.l||1e-9)*100).toFixed(0);

  return{
    trend,direction:trend==='up'?'Long':'Short',
    entry,stop,target,rMultiple,riskDist,
    taps:taps.length,spanWeeks:(span/H4W).toFixed(1),
    priorBreaks,bodyRatio,sweep,stopNote,
    candlesSinceBreak:candles.length-1-breakIdx
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
      const candles=data.values.map(v=>({
        t:new Date(v.datetime).getTime(),
        o:parseFloat(v.open),h:parseFloat(v.high),l:parseFloat(v.low),c:parseFloat(v.close)
      })).reverse();
      const atrSeries=calcATR(candles,14);
      const result=detectBreak(candles,atrSeries);
      if(result) signals.push({symbol,...result});
    }catch(e){console.error('Error for '+symbol+':',e.message);}
    await sleep(900);
  }

  if(signals.length===0){console.log('No A+ signals. No notification sent.');return;}

  const dec=s=>s.includes('JPY')?3:5;
  const title='📈 '+signals.length+' A+ signal'+(signals.length>1?'s':'')+' — Spiraled H4';
  const message=signals.map(s=>
    s.symbol+' — '+s.direction+'\n'+
    s.taps+'-tap line ('+s.spanWeeks+'wks) | body '+s.bodyRatio+'% | '+s.rMultiple.toFixed(1)+'R\n'+
    'Entry: '+s.entry.toFixed(dec(s.symbol))+' | Stop: '+s.stop.toFixed(dec(s.symbol))+' | Target: '+s.target.toFixed(dec(s.symbol))+'\n'+
    (s.candlesSinceBreak===0?'🔴 Break just happened':'🟡 Break was '+s.candlesSinceBreak+' candle(s) ago — consider retest entry')+'\n'+
    (s.sweep?'✓ Liquidity sweep detected':'⚠️ No clear sweep — verify manually')+'\n'+
    '⚠️ Check news + confirm chart before entering'
  ).join('\n\n');

  await notify(title,message);
  console.log('Sent for:',signals.map(s=>s.symbol).join(', '));
}

main();
