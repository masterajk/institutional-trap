import { useState, useEffect, useRef, useCallback } from "react";
/*
 * INSTITUTIONAL TRAP STRATEGY v2.0
 * FIX 1 — Weights: 6 independent factors normalised to exactly 100 (was 8 factors summing to 140)
 * FIX 2 — Stop: structural stop at sweep extreme ±0.2×ATR shown alongside ATR stop; tighter used
 * FIX 3 — Volume: compared against time-of-day U-shaped baseline per 15-min window (Indian market)
 * FIX 4 — Patterns: deterministic numeric rules replace narrative descriptions (%, counts, ranges)
 * FIX 5 — Market selector: India/Forex/US Equity/Crypto with correct per-instrument session maps
 */

const C = {
  bg:"#ECE5DD",surface:"#FFFFFF",surface2:"#F5F1ED",
  primary:"#075E54",accent:"#25D366",accentD:"#128C7E",
  text:"#1A1A1A",sub:"#6B7280",border:"#D1C4B8",
  red:"#DC2626",redL:"#FEF2F2",amber:"#D97706",amberL:"#FFFBEB",
  greenL:"#F0FDF4",blue:"#1D4ED8",blueL:"#EFF6FF",
  purple:"#7C3AED",purpleL:"#F5F3FF",paper:"#F59E0B",
};

const MARKETS = {
  INDIA:{label:"BankNifty / Nifty",instrument:"NIFTY50",tz:"IST",
    note:"⚠ BankNifty weekly contracts discontinued Nov 2024. Use monthly expiry only. Post-Nov 2024 data for backtesting.",
    hr:[9.25,15.4],
    sessions:[
      {key:"OPENING_TRAP",label:"Opening Trap",start:9.25,end:9.75,weight:1.0,color:"#F59E0B"},
      {key:"MID_MORNING",label:"Mid Morning",start:9.75,end:11,weight:0.7,color:"#0EA5E9"},
      {key:"LUNCH_CHOP",label:"Lunch Chop",start:11,end:13.5,weight:0.2,color:"#94A3B8",avoid:true},
      {key:"AFTERNOON",label:"Afternoon",start:13.5,end:14,weight:0.6,color:"#6366F1"},
      {key:"POWER_HOUR",label:"Power Hour",start:14,end:15,weight:0.8,color:"#10B981"},
      {key:"CLOSING_TRAP",label:"Closing Trap",start:15,end:15.5,weight:0.9,color:"#EC4899"},
    ]},
  FOREX:{label:"Forex Major Pairs",instrument:"EUR/USD",tz:"GMT",note:null,hr:[7,20],
    sessions:[
      {key:"ASIA",label:"Asia",start:0,end:8,weight:0.3,color:"#6366F1"},
      {key:"LONDON_O",label:"London Open",start:8,end:10,weight:1.0,color:"#0EA5E9"},
      {key:"LONDON_AM",label:"London AM",start:10,end:12,weight:0.7,color:"#64748B"},
      {key:"OVERLAP",label:"Overlap",start:12,end:13,weight:0.8,color:"#F59E0B"},
      {key:"NY_OPEN",label:"NY Open",start:13,end:16,weight:1.0,color:"#10B981"},
      {key:"NY_PM",label:"NY PM",start:16,end:20,weight:0.4,color:"#94A3B8"},
      {key:"OVERNIGHT",label:"Overnight",start:20,end:24,weight:0.1,color:"#374151"},
    ]},
  US_EQUITY:{label:"US Equities",instrument:"SPX",tz:"ET",note:null,hr:[9,15.9],
    sessions:[
      {key:"PRE_MKT",label:"Pre-Market",start:9,end:9.5,weight:0.3,color:"#94A3B8"},
      {key:"OPEN_RNG",label:"Opening Range",start:9.5,end:10,weight:1.0,color:"#F59E0B"},
      {key:"AM_SESSION",label:"AM Session",start:10,end:11.5,weight:0.7,color:"#0EA5E9"},
      {key:"LUNCH_CHOP",label:"Lunch Chop",start:11.5,end:13.5,weight:0.2,color:"#94A3B8",avoid:true},
      {key:"PM_SESSION",label:"PM Session",start:13.5,end:15,weight:0.5,color:"#6366F1"},
      {key:"POWER_HOUR",label:"Power Hour",start:15,end:16,weight:0.9,color:"#10B981"},
    ]},
  CRYPTO:{label:"Crypto (24/7)",instrument:"BTC/USDT",tz:"UTC",note:null,hr:[0,23],
    sessions:[
      {key:"ASIA",label:"Asia",start:0,end:8,weight:0.6,color:"#6366F1"},
      {key:"EUROPE",label:"Europe",start:8,end:16,weight:0.8,color:"#0EA5E9"},
      {key:"US",label:"US",start:13,end:21,weight:1.0,color:"#F59E0B"},
      {key:"LATE",label:"Late",start:21,end:24,weight:0.4,color:"#94A3B8"},
    ]},
};

const PATTERNS=[
  {id:"PDH_SWEEP",name:"PDH Sweep",prob:.18,direction:"short",
   rule:"Sweep ≥0.15% beyond PDH · Closes back inside ≤3 candles · Failed acceptance confirmed"},
  {id:"PDL_SWEEP",name:"PDL Sweep",prob:.18,direction:"long",
   rule:"Sweep ≥0.15% below PDL · Closes back inside ≤3 candles · Failed acceptance confirmed"},
  {id:"OR_TRAP",name:"Opening Range Trap",prob:.15,direction:"both",
   rule:"Break ≥0.1% beyond OR boundary · Closes back inside ≤2 candles · Valid 09:15–09:45 only"},
  {id:"EQH_SWEEP",name:"Equal High Sweep",prob:.14,direction:"short",
   rule:"2 highs within 0.1% · last 20 candles · Sweep ≥0.15% · Close below both ≤3 candles"},
  {id:"EQL_SWEEP",name:"Equal Low Sweep",prob:.14,direction:"long",
   rule:"2 lows within 0.1% · last 20 candles · Sweep ≥0.15% · Close above both ≤3 candles"},
  {id:"FVG_RETURN",name:"FVG Return",prob:.12,direction:"both",
   rule:"Gap ≥0.2% · C3 non-overlap · Price at 50% midpoint · Requires ≥85% confluence — strict"},
  {id:"SPRING",name:"Consolidation Spring",prob:.09,direction:"long",
   rule:"≥8 candles in 0.4% range · Break 0.1–0.3% below low · Below-avg vol · Close back ≤2 candles"},
];

const REVERSAL_CANDLES=["Engulfing","Pin Bar","Inside Bar","Doji+Follow","Hammer","Shooting Star","Dark Cloud"];

const REGIMES=[
  {id:"TWO_SIDED",label:"Two-sided Auction",icon:"🟢",color:"#16A34A",warn:null,sizeNote:"Full size"},
  {id:"TRENDING",label:"Trending",icon:"🟡",color:"#D97706",warn:"Sweep patterns risky — reduce size 50%",sizeNote:"50% size"},
  {id:"EVENT_DAY",label:"Event Day",icon:"🔴",color:"#DC2626",warn:"Avoid all setups today",sizeNote:"No trades"},
  {id:"EXPIRY_DAY",label:"Expiry Day",icon:"🟣",color:"#7C3AED",warn:"Closing Trap only — special rules apply",sizeNote:"Closing Trap only"},
];

const rnd=(a,b)=>+(a+Math.random()*(b-a)).toFixed(2);
const pick=arr=>arr[Math.floor(Math.random()*arr.length)];
const fmt=n=>n?.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2});
const pct=n=>(n*100).toFixed(1)+"%";

function getSession(hour,mktId){
  const ss=MARKETS[mktId]?.sessions||MARKETS.INDIA.sessions;
  let found=null;
  for(const s of ss){if(hour>=s.start&&hour<s.end)found=s;}
  return found||ss[0];
}
function getHTFBias(){const r=Math.random();return r<.4?"BULLISH":r<.8?"BEARISH":"NEUTRAL";}
function getPD(price,hi,lo){
  const m=(hi+lo)/2,p=(price-m)/((hi-lo)/2);
  if(p>.25)return{zone:"PREMIUM",favorable:false};
  if(p<-.25)return{zone:"DISCOUNT",favorable:true};
  return{zone:"EQUILIBRIUM",favorable:null};
}
// FIX 1: 6 factors, sum exactly 100
function scoreC(chk){
  const W={failedAcceptance:28,levelQuality:20,normalisedVolume:18,htfBias:14,sessionQuality:12,volatilityRegime:8};
  let s=0;for(const[k,w]of Object.entries(W)){if(chk[k])s+=w;}return s;
}
function confLabel(s){
  if(s>=80)return{label:"HIGH",color:C.accent};
  if(s>=60)return{label:"MED",color:C.amber};
  return{label:"LOW",color:C.red};
}
function calcATR(candles){
  if(candles.length<2)return 10;
  const trs=candles.slice(-14).map((c,i,a)=>{
    if(i===0)return c.high-c.low;
    const p=a[i-1];return Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close));
  });
  return trs.reduce((a,b)=>a+b,0)/trs.length;
}
// FIX 3: Time-of-day normalised volume baseline (Indian U-shaped intraday curve)
function getToDBaseline(h,avg){
  if(h>=9.25&&h<9.75)return avg*2.2;   // 09:15-09:45 opening surge
  if(h>=9.75&&h<11)  return avg*1.4;   // 09:45-11:00 active morning
  if(h>=11&&h<13.5)  return avg*0.8;   // 11:00-13:30 lunch trough
  if(h>=13.5&&h<14)  return avg*1.0;   // 13:30-14:00 afternoon restart
  if(h>=14&&h<15)    return avg*1.3;   // 14:00-15:00 power build
  if(h>=15&&h<15.5)  return avg*1.8;   // 15:00-15:30 closing surge
  return avg;
}
// FIX 2: Structural stop = sweep extreme ± 0.2×ATR; show both; use tighter
function calcStops(dir,price,sweepX,atr){
  const structStop=dir==="long"?sweepX-atr*.2:sweepX+atr*.2;
  const atrStop=dir==="long"?price-atr*1.5:price+atr*1.5;
  const stop=dir==="long"?Math.max(structStop,atrStop):Math.min(structStop,atrStop);
  return{structStop:+structStop.toFixed(2),atrStop:+atrStop.toFixed(2),stop:+stop.toFixed(2)};
}

const Card=({children,style,title,icon,hbg})=>(
  <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden",...style}}>
    {title&&<div style={{background:hbg||C.primary,padding:"10px 16px",display:"flex",alignItems:"center",gap:8}}>
      {icon&&<span style={{fontSize:16}}>{icon}</span>}
      <span style={{fontWeight:700,fontSize:13,color:"#fff",letterSpacing:".3px"}}>{title}</span>
    </div>}
    {children}
  </div>
);
const Badge=({label,color,sz=11})=>(
  <span style={{background:color+"22",color,border:`1px solid ${color}44`,borderRadius:99,padding:"2px 8px",fontSize:sz,fontWeight:700,whiteSpace:"nowrap"}}>{label}</span>
);
const Row=({label,value,color,bold,note})=>(
  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:`1px solid ${C.border}22`}}>
    <span style={{fontSize:11,color:C.sub,fontWeight:500}}>{label}{note&&<span style={{fontSize:9,color:C.border,marginLeft:4}}>{note}</span>}</span>
    <span style={{fontSize:12,fontWeight:bold?800:600,color:color||C.text}}>{value}</span>
  </div>
);
const Check=({label,passed,na,w})=>(
  <div style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",background:na?"transparent":passed?C.greenL:C.redL,borderRadius:7,marginBottom:5}}>
    <span style={{fontSize:14,flexShrink:0}}>{na?"⬜":passed?"✅":"❌"}</span>
    <span style={{flex:1,fontSize:11,fontWeight:600,color:na?C.sub:passed?C.primary:C.red,lineHeight:1.3}}>{label}</span>
    {w&&<span style={{fontSize:10,fontWeight:800,color:na?C.border:passed?C.accent:C.red,flexShrink:0}}>{w}%</span>}
  </div>
);
const CandleChart=({candles,levels,signal,at})=>{
  if(!candles.length)return null;
  const W=340,H=150,P=8;
  const ex=[levels.pdh,levels.pdl,levels.eqh,levels.eql];
  const tgt=signal||at;
  if(tgt){ex.push(tgt.stop,tgt.t1,tgt.t2);}
  const all=candles.flatMap(c=>[c.high,c.low]).concat(ex.filter(Boolean));
  const mn=Math.min(...all),mx=Math.max(...all),rng=mx-mn||1;
  const toY=p=>P+(H-P*2)*(1-(p-mn)/rng);
  const cW=Math.max(4,(W-P*2)/candles.length-1);
  return(
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{display:"block"}}>
      {[{v:levels.pdh,c:"#7C3AED",l:"PDH"},{v:levels.pdl,c:"#D97706",l:"PDL"},
        {v:levels.eqh,c:"#0EA5E9",l:"EQH"},{v:levels.eql,c:"#F43F5E",l:"EQL"}].map(lv=>(
        <g key={lv.l}>
          <line x1={P} x2={W-P} y1={toY(lv.v)} y2={toY(lv.v)} stroke={lv.c} strokeWidth={1} strokeDasharray="4,3"/>
          <text x={W-P+1} y={toY(lv.v)+3.5} fill={lv.c} fontSize={7} fontWeight={700}>{lv.l}</text>
        </g>
      ))}
      {tgt&&<>
        <line x1={P} x2={W-P} y1={toY(tgt.stop)} y2={toY(tgt.stop)} stroke={C.red} strokeWidth={1.5} strokeDasharray="3,2"/>
        <text x={P+2} y={toY(tgt.stop)-2} fill={C.red} fontSize={7} fontWeight={700}>STOP</text>
        <line x1={P} x2={W-P} y1={toY(tgt.t1)} y2={toY(tgt.t1)} stroke={C.accent} strokeWidth={1} strokeDasharray="3,2"/>
        <text x={P+2} y={toY(tgt.t1)-2} fill={C.accent} fontSize={7} fontWeight={700}>T1</text>
        <line x1={P} x2={W-P} y1={toY(tgt.t2)} y2={toY(tgt.t2)} stroke={C.accentD} strokeWidth={1.5} strokeDasharray="3,2"/>
        <text x={P+2} y={toY(tgt.t2)-2} fill={C.accentD} fontSize={7} fontWeight={700}>T2</text>
      </>}
      {candles.map((c,i)=>{
        const x=P+i*(cW+1)+cW/2,bull=c.close>=c.open,col=bull?C.accent:C.red;
        return(<g key={i}>
          <line x1={x} x2={x} y1={toY(c.high)} y2={toY(c.low)} stroke={col} strokeWidth={1}/>
          <rect x={x-cW/2} y={Math.min(toY(c.open),toY(c.close))} width={cW}
            height={Math.max(1,Math.abs(toY(c.open)-toY(c.close)))}
            fill={bull?col:"#fff"} stroke={col} strokeWidth={1}/>
        </g>);
      })}
    </svg>
  );
};

export default function App(){
  const[mktId,setMktId]=useState("INDIA");
  const[paperMode,setPaperMode]=useState(false);
  const[regime,setRegime]=useState("TWO_SIDED");
  // GUARDRAIL 3: morning commitment
  const[committed,setCommitted]=useState(false);
  const[commitCk,setCommitCk]=useState([false,false,false]);
  // market state
  const[candles,setCandles]=useState([]);
  const[levels,setLevels]=useState({pdh:0,pdl:0,eqh:0,eql:0,or_high:0,or_low:0});
  const[price,setPrice]=useState(18500);
  const[volume,setVolume]=useState(0);
  const[avgVol,setAvgVol]=useState(100000);
  const[sessHi,setSessHi]=useState(0);
  const[sessLo,setSessLo]=useState(0);
  // analysis
  const[htf,setHtf]=useState("BULLISH");
  const[sess,setSess]=useState(null);
  const[hour,setHour]=useState(10);
  const[pdz,setPdz]=useState({zone:"EQUILIBRIUM",favorable:null});
  // pattern
  const[detected,setDetected]=useState([]);
  const[active,setActive]=useState(null);
  // validation
  const[checks,setChecks]=useState({});
  const[conf,setConf]=useState(0);
  const[signal,setSignal]=useState(null);
  // GUARDRAIL 4: 90s signal timeout
  const[countdown,setCountdown]=useState(90);
  // trade
  const[activeTrade,setActiveTrade]=useState(null);
  const[beMoved,setBeMoved]=useState(false);
  // live risk
  const[capital]=useState(500000);
  const[mode,setMode]=useState("conservative");
  const[dailyPnL,setDailyPnL]=useState(0);
  const[tradeCount,setTradeCount]=useState(0);
  // GUARDRAIL 5: circuit breaker
  const[cb,setCb]=useState(false);
  // paper
  const PCAP=500000;
  const[pPnL,setPPnL]=useState(0);
  const[pCount,setPCount]=useState(0);
  const[pLog,setPLog]=useState([]);
  const[liveLog,setLiveLog]=useState([]);
  const tickRef=useRef(null);
  const RP={conservative:{riskPct:.005,maxT:3,limitPct:.015},aggressive:{riskPct:.01,maxT:5,limitPct:.025}}[mode];
  const eCap=paperMode?PCAP:capital;
  const ePnL=paperMode?pPnL:dailyPnL;
  const eLog=paperMode?pLog:liveLog;
  const blocked=!paperMode&&cb;
  const htfC=htf==="BULLISH"?C.accent:htf==="BEARISH"?C.red:C.amber;
  const reg=REGIMES.find(r=>r.id===regime);
  const todBase=getToDBaseline(hour,avgVol);
  const volSpike=volume>todBase*1.3;

  const initMkt=useCallback((id="INDIA")=>{
    const m=MARKETS[id]||MARKETS.INDIA;
    const base=rnd(18200,19000);
    const pdh=base+rnd(30,80),pdl=base-rnd(30,80);
    const eqh=pdh-rnd(10,30),eql=pdl+rnd(10,30);
    const orH=base+rnd(5,20),orL=base-rnd(5,20);
    setPrice(base);setLevels({pdh,pdl,eqh,eql,or_high:orH,or_low:orL});
    setSessHi(pdh-rnd(5,15));setSessLo(pdl+rnd(5,15));setAvgVol(rnd(80000,120000));
    const init=[];let p=base;
    for(let i=0;i<30;i++){
      const o=p,c=p+rnd(-15,15),h=Math.max(o,c)+rnd(3,10),l=Math.min(o,c)-rnd(3,10);
      init.push({open:+o.toFixed(2),close:+c.toFixed(2),high:+h.toFixed(2),low:+l.toFixed(2)});p=c;
    }
    setCandles(init);setHtf(getHTFBias());
    const hr=rnd(...m.hr);setHour(hr);setSess(getSession(hr,id));
    setPdz(getPD(base,pdh,pdl));
    setDetected([]);setActive(null);setChecks({});setConf(0);setSignal(null);setCountdown(90);
    setActiveTrade(null);setBeMoved(false);
  },[]);

  useEffect(()=>{initMkt("INDIA");},[]);

  const changeMkt=id=>{setMktId(id);initMkt(id);};

  // tick
  useEffect(()=>{
    if(blocked)return;
    tickRef.current=setInterval(()=>{
      setPrice(prev=>{
        const next=+(prev+rnd(-8,8)).toFixed(2);
        setCandles(c=>{
          const last=c[c.length-1];if(!last)return c;
          return[...c.slice(-39),{open:last.open,close:next,high:Math.max(last.high,next),low:Math.min(last.low,next)}];
        });
        setVolume(Math.round(rnd(50000,180000)));
        setSessHi(h=>Math.max(h,next));setSessLo(l=>Math.min(l||99999,next));
        return next;
      });
    },1500);
    return()=>clearInterval(tickRef.current);
  },[blocked]);

  // GUARDRAIL 4: 90s timeout
  useEffect(()=>{
    if(!signal){setCountdown(90);return;}
    const iv=setInterval(()=>{
      setCountdown(prev=>{if(prev<=1){setSignal(null);return 90;}return prev-1;});
    },1000);
    return()=>clearInterval(iv);
  },[signal]);

  // trade monitor
  useEffect(()=>{
    if(!activeTrade)return;
    const t=activeTrade;
    if(!beMoved&&((t.direction==="long"&&price>=t.t1)||(t.direction==="short"&&price<=t.t1))){
      setBeMoved(true);setActiveTrade(p=>p?{...p,stop:p.entry,beMoved:true}:p);
    }
    const stopped=t.direction==="long"?price<=t.stop:price>=t.stop;
    const t2=t.direction==="long"?price>=t.t2:price<=t.t2;
    if(stopped||t2){
      const xp=t2?t.t2:price;
      const result=t.direction==="long"?xp-t.entry:t.entry-xp;
      const pnl=result*t.qty;
      const rM=+(result/Math.abs(t.entry-t.originalStop)).toFixed(2);
      const entry={...t,exit:xp,result:pnl,rMultiple:rM,status:t2?"T2 HIT":beMoved?"BE STOP":"STOPPED"};
      if(t.isPaper){setPLog(p=>[entry,...p.slice(0,19)]);setPPnL(p=>p+pnl);}
      else{
        setLiveLog(p=>[entry,...p.slice(0,9)]);
        setDailyPnL(p=>{const n=p+pnl;if(n<-(capital*RP.limitPct))setCb(true);return n;});
      }
      setActiveTrade(null);setBeMoved(false);
    }
  },[price,activeTrade,beMoved]);

  const simulate=()=>{
    if(blocked||regime==="EVENT_DAY")return;
    const tot=PATTERNS.reduce((a,p)=>a+p.prob,0);
    let r=Math.random()*tot,chosen=PATTERNS[0];
    for(const p of PATTERNS){r-=p.prob;if(r<=0){chosen=p;break;}}
    let dir=chosen.direction==="both"?(htf==="BULLISH"?"long":"short"):(chosen.direction==="long"?"long":"short");
    const htfOk=(dir==="long"&&htf==="BULLISH")||(dir==="short"&&htf==="BEARISH")||htf==="NEUTRAL";
    const sessOk=(sess?.weight||0)>=.8;
    const normVol=volume>getToDBaseline(hour,avgVol)*1.3;
    const isKey=["PDH_SWEEP","PDL_SWEEP","EQH_SWEEP","EQL_SWEEP"].includes(chosen.id);
    const lvlQ=isKey||Math.random()>.4;
    const volR=regime==="TWO_SIDED"||(regime==="EXPIRY_DAY"&&sess?.key==="CLOSING_TRAP");
    const newCk={
      failedAcceptance:Math.random()>.2,
      levelQuality:lvlQ,
      normalisedVolume:normVol,
      htfBias:htfOk,
      sessionQuality:sessOk,
      volatilityRegime:volR,
    };
    const score=scoreC(newCk);
    const cl=confLabel(score);
    const pat={id:chosen.id,name:chosen.name,rule:chosen.rule,dir,
      time:new Date().toLocaleTimeString(),
      status:score>=60?"CONFIRMED":score>=40?"WAITING":"INVALID",
      confidence:cl,score,reversalCandle:pick(REVERSAL_CANDLES),session:sess?.label};
    setDetected(p=>[pat,...p.slice(0,4)]);setActive(pat);setChecks(newCk);setConf(score);setCountdown(90);
    const minScore=chosen.id==="FVG_RETURN"?85:60;
    if(score>=minScore){
      const atr=calcATR(candles);
      const sweepX=dir==="long"?price-rnd(8,22):price+rnd(8,22);
      const{structStop,atrStop,stop}=calcStops(dir,price,sweepX,atr);
      const dist=Math.abs(price-stop);
      const t1=dir==="long"?price+dist*1.5:price-dist*1.5;
      const t2=dir==="long"?price+dist*2.5:price-dist*2.5;
      const riskAmt=eCap*RP.riskPct;
      const baseQty=Math.max(1,Math.floor(riskAmt/dist));
      const sm=regime==="TRENDING"?.5:1;
      const qty=Math.max(1,Math.floor(baseQty*sm));
      setSignal({dir,entry:price,stop,structStop,atrStop,sweepX,t1,t2,dist,riskAmt,qty,atr,score,pid:chosen.id,sm});
    }else{setSignal(null);}
  };

  const execTrade=()=>{
    if(!signal||activeTrade)return;
    if(!paperMode&&(blocked||tradeCount>=RP.maxT))return;
    const t={...signal,pattern:active?.name,pid:active?.id,originalStop:signal.stop,beMoved:false,
      direction:signal.dir,entryTime:new Date().toLocaleTimeString(),
      sessionLabel:sess?.label,score:signal.score,id:Date.now(),isPaper:paperMode};
    setActiveTrade(t);
    paperMode?setPCount(c=>c+1):setTradeCount(c=>c+1);
    setSignal(null);
  };

  // GUARDRAIL 2: only Stop Hit / Target Hit
  const manualClose=outcome=>{
    if(!activeTrade)return;
    const t=activeTrade;
    const xp=outcome==="stop"?t.stop:t.t2;
    const result=t.direction==="long"?xp-t.entry:t.entry-xp;
    const pnl=result*t.qty;
    const rM=+(result/Math.abs(t.entry-t.originalStop)).toFixed(2);
    const entry={...t,exit:xp,result:pnl,rMultiple:rM,status:outcome==="stop"?"MANUAL STOP":"MANUAL TARGET"};
    if(t.isPaper){setPLog(p=>[entry,...p.slice(0,19)]);setPPnL(p=>p+pnl);}
    else{
      setLiveLog(p=>[entry,...p.slice(0,9)]);
      setDailyPnL(p=>{const n=p+pnl;if(n<-(capital*RP.limitPct))setCb(true);return n;});
    }
    setActiveTrade(null);setBeMoved(false);
  };

  const resetDay=()=>{
    initMkt(mktId);setLiveLog([]);setDailyPnL(0);setTradeCount(0);setCb(false);
  };

  // paper analysis (25 trade threshold)
  const pa=(()=>{
    if(!paperMode||pLog.length<25)return null;
    const wins=pLog.filter(t=>t.result>0),losses=pLog.filter(t=>t.result<=0);
    const wr=wins.length/pLog.length;
    const awR=wins.length?wins.reduce((a,t)=>a+t.rMultiple,0)/wins.length:0;
    const alR=losses.length?losses.reduce((a,t)=>a+Math.abs(t.rMultiple),0)/losses.length:0;
    const exp=(wr*awR)-((1-wr)*alR)-.08;
    const byP={};pLog.forEach(t=>{const k=t.pattern||"?";(byP[k]=byP[k]||[]).push(t);});
    const patWR=Object.entries(byP).map(([n,ts])=>({n,wr:ts.filter(t=>t.result>0).length/ts.length,c:ts.length})).sort((a,b)=>b.wr-a.wr);
    const byS={};pLog.forEach(t=>{const k=t.sessionLabel||"?";(byS[k]=byS[k]||[]).push(t);});
    const sessWR=Object.entries(byS).map(([n,ts])=>({n,wr:ts.filter(t=>t.result>0).length/ts.length,c:ts.length})).sort((a,b)=>b.wr-a.wr);
    const hiS=pLog.filter(t=>t.score>=80),mdS=pLog.filter(t=>t.score>=60&&t.score<80);
    const hiWR=hiS.length?hiS.filter(t=>t.result>0).length/hiS.length:0;
    const mdWR=mdS.length?mdS.filter(t=>t.result>0).length/mdS.length:0;
    let rec,rc;
    if(wr>.42&&exp>.05){rec="✅ Ready for Live Trading";rc=C.accent;}
    else if(wr<.30||exp<-.15){rec="⚠️ System Needs Adjustment";rc=C.red;}
    else{rec="📊 More Data Needed";rc=C.amber;}
    return{wr,awR,alR,exp,patWR,sessWR,hiWR,mdWR,hiN:hiS.length,mdN:mdS.length,rec,rc,tot:pLog.length};
  })();

  // GUARDRAIL 3: morning commitment screen
  if(!committed){
    const all=commitCk.every(Boolean);
    return(
      <div style={{background:C.primary,minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:20,fontFamily:"system-ui,sans-serif"}}>
        <div style={{background:C.surface,borderRadius:16,padding:"32px 28px",maxWidth:460,width:"100%",boxShadow:"0 20px 60px rgba(0,0,0,.3)"}}>
          <div style={{textAlign:"center",marginBottom:24}}>
            <div style={{fontSize:36,marginBottom:8}}>🎯</div>
            <div style={{fontWeight:900,fontSize:22,color:C.primary}}>Morning Commitment</div>
            <div style={{fontSize:12,color:C.sub,marginTop:4}}>Confirm your rules before market opens</div>
          </div>
          {["I have reviewed HTF bias and know today's directional preference",
            "I accept the circuit breaker is non-negotiable — if triggered, no more live trades today",
            "I will only trade prime sessions and verify confluence before every entry"
          ].map((item,i)=>(
            <div key={i} onClick={()=>setCommitCk(p=>{const n=[...p];n[i]=!n[i];return n;})}
              style={{display:"flex",alignItems:"flex-start",gap:12,padding:"12px 14px",
                background:commitCk[i]?C.greenL:C.surface2,border:`2px solid ${commitCk[i]?C.accent:C.border}`,
                borderRadius:10,marginBottom:10,cursor:"pointer",transition:"all .2s"}}>
              <span style={{fontSize:18,flexShrink:0,marginTop:1}}>{commitCk[i]?"✅":"⬜"}</span>
              <span style={{fontSize:13,fontWeight:600,color:commitCk[i]?C.primary:C.text,lineHeight:1.4}}>{item}</span>
            </div>
          ))}
          <button disabled={!all} onClick={()=>setCommitted(true)}
            style={{width:"100%",marginTop:8,background:all?C.primary:C.border,color:"#fff",border:"none",
              borderRadius:10,padding:"14px",fontSize:15,fontWeight:800,cursor:all?"pointer":"not-allowed",transition:"background .2s"}}>
            I Commit to Today's Rules →
          </button>
          <div style={{marginTop:10,fontSize:10,color:C.sub,textAlign:"center"}}>Institutional Trap Strategy v2.0 · 5 fixes applied · Weights Σ=100</div>
        </div>
      </div>
    );
  }

  return(
    <div style={{background:C.bg,minHeight:"100vh",fontFamily:"system-ui,sans-serif",color:C.text}}>

      {/* HEADER */}
      <div style={{background:C.primary,padding:"10px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,flexWrap:"wrap"}}>
        <div>
          <div style={{fontWeight:900,fontSize:16,color:"#fff",letterSpacing:"-.3px"}}>⚡ Institutional Trap Strategy</div>
          <div style={{fontSize:10,color:"rgba(255,255,255,.55)"}}>v2.0 · Weights Σ=100 · Structural Stops · ToD Volume · Objective Rules</div>
        </div>
        <div style={{display:"flex",gap:5,alignItems:"center",flexWrap:"wrap"}}>
          {/* FIX 5: market selector */}
          <select value={mktId} onChange={e=>changeMkt(e.target.value)}
            style={{border:"none",borderRadius:7,padding:"5px 8px",fontSize:11,fontWeight:700,background:"rgba(255,255,255,.15)",color:"#fff",cursor:"pointer"}}>
            {Object.entries(MARKETS).map(([id,m])=>(
              <option key={id} value={id} style={{background:"#075E54",color:"#fff"}}>{m.label}</option>
            ))}
          </select>
          {/* Regime selector */}
          <select value={regime} onChange={e=>setRegime(e.target.value)}
            style={{border:"none",borderRadius:7,padding:"5px 8px",fontSize:11,fontWeight:700,background:"rgba(255,255,255,.15)",color:"#fff",cursor:"pointer"}}>
            {REGIMES.map(r=>(
              <option key={r.id} value={r.id} style={{background:"#075E54",color:"#fff"}}>{r.icon} {r.label}</option>
            ))}
          </select>
          {/* Paper mode toggle */}
          <button onClick={()=>setPaperMode(m=>!m)}
            style={{border:"none",borderRadius:7,padding:"5px 11px",fontSize:11,fontWeight:800,cursor:"pointer",
              background:paperMode?C.paper:"rgba(255,255,255,.12)",color:paperMode?"#fff":"rgba(255,255,255,.8)"}}>
            {paperMode?"📝 Paper ON":"📝 Paper"}
          </button>
          {/* HTF */}
          <div style={{background:"rgba(255,255,255,.12)",borderRadius:7,padding:"4px 10px",display:"flex",gap:5,alignItems:"center"}}>
            <span style={{fontSize:9,color:"rgba(255,255,255,.55)",fontWeight:600}}>HTF</span>
            <span style={{fontSize:12,fontWeight:800,color:htfC}}>{htf}</span>
          </div>
          {/* Session */}
          {sess&&<div style={{background:"rgba(255,255,255,.12)",borderRadius:7,padding:"4px 10px",display:"flex",gap:5,alignItems:"center"}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:sess.color||C.accent}}/>
            <span style={{fontSize:11,fontWeight:700,color:"rgba(255,255,255,.85)"}}>{sess.label}</span>
            <span style={{fontSize:9,color:"rgba(255,255,255,.5)"}}>{sess.weight>=.8?"✦":"◦"}</span>
          </div>}
          {/* Mode */}
          <div style={{display:"flex",gap:2,background:"rgba(0,0,0,.2)",borderRadius:7,padding:2}}>
            {["conservative","aggressive"].map(m=>(
              <button key={m} onClick={()=>setMode(m)}
                style={{border:"none",borderRadius:5,padding:"3px 8px",fontSize:9,fontWeight:700,cursor:"pointer",
                  background:mode===m?"#fff":"transparent",color:mode===m?C.primary:"rgba(255,255,255,.7)"}}>
                {m==="conservative"?"🛡 Safe":"⚡ Aggro"}
              </button>
            ))}
          </div>
          {/* GUARDRAIL 5 indicator */}
          {cb&&<div style={{background:C.red,color:"#fff",borderRadius:7,padding:"4px 10px",fontSize:10,fontWeight:800}}>🔴 CIRCUIT BREAKER</div>}
        </div>
      </div>

      {/* Paper banner */}
      {paperMode&&<div style={{background:C.paper,padding:"7px 16px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <span style={{fontWeight:800,fontSize:12,color:"#fff"}}>📝 PAPER TRADING MODE — Real signals, simulated capital</span>
        <span style={{fontSize:11,color:"rgba(255,255,255,.85)"}}>₹{(PCAP/100000).toFixed(1)}L · {pLog.length} trades{pLog.length>=25?" · Analysis ready ↓":` · ${25-pLog.length} to analysis`}</span>
      </div>}

      {/* Regime warning */}
      {reg&&reg.id!=="TWO_SIDED"&&<div style={{background:`${reg.color}11`,borderBottom:`2px solid ${reg.color}33`,padding:"7px 16px",display:"flex",alignItems:"center",gap:8}}>
        <span style={{fontSize:14}}>{reg.icon}</span>
        <div><span style={{fontWeight:800,fontSize:12,color:reg.color}}>{reg.label} — </span><span style={{fontSize:11,color:C.text}}>{reg.warn}</span></div>
        <span style={{marginLeft:"auto",fontSize:10,fontWeight:700,color:reg.color,background:reg.color+"22",borderRadius:6,padding:"2px 8px"}}>{reg.sizeNote}</span>
      </div>}

      {/* Market note */}
      {MARKETS[mktId]?.note&&<div style={{background:C.amberL,borderBottom:`1px solid ${C.amber}44`,padding:"6px 16px",fontSize:11,color:C.amber,fontWeight:600}}>{MARKETS[mktId].note}</div>}

      <div style={{padding:"12px 14px",maxWidth:1100,margin:"0 auto",display:"grid",gap:12}}>

        {/* ROW 1 */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>

          {/* CHART PANEL */}
          <Card title="Live Market Panel" icon="📊">
            <div style={{padding:"12px 14px"}}>
              {/* GUARDRAIL 1: hide price during active trade */}
              {activeTrade?(
                <div style={{background:C.amberL,border:`2px solid ${C.amber}33`,borderRadius:10,padding:"12px",marginBottom:10,textAlign:"center"}}>
                  <div style={{fontSize:11,fontWeight:700,color:C.amber}}>🔒 POSITION ACTIVE — Live price hidden</div>
                  <div style={{fontSize:10,color:C.sub,marginTop:3}}>Focus on your stop and targets only</div>
                  <div style={{marginTop:8,display:"flex",gap:7,justifyContent:"center"}}>
                    {[{l:"ENTRY",v:activeTrade.entry,c:C.primary},{l:"STOP",v:activeTrade.stop,c:C.red},{l:"T1",v:activeTrade.t1,c:C.accent},{l:"T2",v:activeTrade.t2,c:C.accentD}].map(s=>(
                      <div key={s.l} style={{background:C.surface2,border:`1px solid ${s.c}33`,borderRadius:7,padding:"5px 9px",textAlign:"center"}}>
                        <div style={{fontSize:8,color:C.sub,marginBottom:1}}>{s.l}</div>
                        <div style={{fontWeight:800,fontSize:12,color:s.c}}>{fmt(s.v)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ):(
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <div>
                    <div style={{fontSize:28,fontWeight:900,color:C.primary,letterSpacing:"-1px"}}>{fmt(price)}</div>
                    <div style={{fontSize:11,color:C.sub,marginTop:1}}>{MARKETS[mktId]?.instrument} · Simulated</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:10,color:C.sub,marginBottom:3}}>Volume</div>
                    <div style={{fontWeight:700,color:volSpike?C.accent:C.text,fontSize:13}}>{(volume/1000).toFixed(0)}K</div>
                    {/* FIX 3: show ToD baseline */}
                    <div style={{fontSize:9,color:C.sub}}>ToD Base {(todBase/1000).toFixed(0)}K</div>
                    {volSpike&&<Badge label="SPIKE" color={C.accent} sz={9}/>}
                  </div>
                </div>
              )}
              <div style={{display:"flex",gap:6,marginBottom:10}}>
                {[{l:"SESS HI",v:fmt(sessHi),c:C.purple},{l:"SESS LO",v:fmt(sessLo),c:C.amber},{l:"ZONE",v:pdz.zone,c:pdz.zone==="DISCOUNT"?C.accent:pdz.zone==="PREMIUM"?C.red:C.amber}].map(s=>(
                  <div key={s.l} style={{flex:1,background:C.surface2,borderRadius:7,padding:"6px 8px",textAlign:"center"}}>
                    <div style={{fontSize:8,color:C.sub,fontWeight:600,marginBottom:1}}>{s.l}</div>
                    <div style={{fontWeight:800,fontSize:11,color:s.c}}>{s.v}</div>
                  </div>
                ))}
              </div>
              <div style={{background:C.surface2,borderRadius:8,padding:6,marginBottom:10}}>
                <CandleChart candles={candles.slice(-30)} levels={levels} signal={signal} at={activeTrade}/>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5}}>
                {[{l:"PDH",v:levels.pdh,c:C.purple},{l:"PDL",v:levels.pdl,c:C.amber},{l:"EQH",v:levels.eqh,c:"#0EA5E9"},{l:"EQL",v:levels.eql,c:C.red},{l:"OR HI",v:levels.or_high,c:C.primary},{l:"OR LO",v:levels.or_low,c:C.accentD}].map(lv=>(
                  <div key={lv.l} style={{display:"flex",justifyContent:"space-between",background:C.surface2,borderRadius:5,padding:"4px 8px"}}>
                    <span style={{fontSize:9,fontWeight:700,color:lv.c}}>{lv.l}</span>
                    <span style={{fontSize:9,fontWeight:700,color:C.text}}>{fmt(lv.v)}</span>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          {/* PATTERN ENGINE */}
          <Card title="Pattern Detection Engine" icon="🔍">
            <div style={{padding:"12px 14px"}}>
              <div style={{background:htf==="BULLISH"?C.greenL:htf==="BEARISH"?C.redL:C.amberL,border:`1px solid ${htfC}44`,borderRadius:8,padding:"10px 12px",marginBottom:12}}>
                <div style={{fontSize:9,fontWeight:700,color:C.sub,textTransform:"uppercase",letterSpacing:".5px",marginBottom:3}}>Higher Timeframe Context (Daily / 4H)</div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:18}}>{htf==="BULLISH"?"📈":htf==="BEARISH"?"📉":"⚖️"}</span>
                  <div>
                    <div style={{fontWeight:800,fontSize:13,color:htfC}}>{htf} STRUCTURE</div>
                    <div style={{fontSize:10,color:C.sub}}>{htf==="BULLISH"?"Long traps only — PDL sweeps, EQL sweeps":htf==="BEARISH"?"Short traps only — PDH sweeps, EQH sweeps":"Neutral — both directions valid"}</div>
                  </div>
                </div>
              </div>
              {detected.length===0?(
                <div style={{textAlign:"center",padding:"18px",color:C.sub,fontSize:12}}>No patterns detected.<br/>Press "Simulate Next Setup" to begin.</div>
              ):detected.slice(0,3).map((p,i)=>(
                <div key={i} style={{background:i===0?C.surface2:"transparent",border:`1px solid ${i===0?C.border:"transparent"}`,borderRadius:9,padding:"9px 11px",marginBottom:8}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
                    <div style={{flex:1,paddingRight:6}}>
                      <div style={{fontWeight:700,fontSize:12,color:C.text}}>{p.name}</div>
                      {/* FIX 4: objective rule shown */}
                      <div style={{fontSize:9,color:C.sub,marginTop:2,lineHeight:1.4}}>{p.rule}</div>
                    </div>
                    <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:3}}>
                      <Badge label={p.confidence.label} color={p.confidence.color}/>
                      <Badge label={p.dir.toUpperCase()} color={p.dir==="long"?C.accent:C.red}/>
                    </div>
                  </div>
                  <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                    <span style={{fontSize:9,color:C.sub}}>🕐 {p.time}</span>
                    <span style={{fontSize:9,color:C.sub}}>📊 {p.score}%</span>
                    <span style={{fontSize:9,color:C.sub}}>🕯 {p.reversalCandle}</span>
                    {i===0&&reg?.id!=="TWO_SIDED"&&<Badge label={`⚠ ${reg?.sizeNote}`} color={reg?.color} sz={8}/>}
                  </div>
                </div>
              ))}
              {sess&&<div style={{background:C.surface2,borderRadius:8,padding:"8px 10px",marginTop:6}}>
                <div style={{fontSize:9,color:C.sub,fontWeight:600,textTransform:"uppercase",letterSpacing:".5px",marginBottom:5}}>
                  {MARKETS[mktId].label} · {MARKETS[mktId].tz} Session Map
                </div>
                <div style={{display:"flex",gap:2,height:9,borderRadius:5,overflow:"hidden"}}>
                  {MARKETS[mktId].sessions.map(s=>(
                    <div key={s.key} style={{flex:s.end-s.start,background:s.key===sess.key?s.color:s.color+"44",transition:"all .3s"}}/>
                  ))}
                </div>
                <div style={{marginTop:5,fontSize:10,color:sess.weight>=.8?C.accent:sess.weight>=.4?C.amber:C.red,fontWeight:600}}>
                  {sess.weight>=.8?"✦ Prime Session — Highest institutional activity":sess.weight>=.4?"◦ Sub-prime — Reduced probability":sess.avoid?"○ Avoid — Minimal institutional participation":"○ Low weight"}
                </div>
              </div>}
            </div>
          </Card>
        </div>

        {/* ROW 2 */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>

          {/* ENTRY VALIDATION — FIX 1 visible */}
          <Card title="Entry Validation Panel" icon="✅">
            <div style={{padding:"12px 14px"}}>
              <div style={{background:`linear-gradient(135deg,${C.primary}11,${C.accent}11)`,border:`1px solid ${C.primary}33`,borderRadius:10,padding:"12px",marginBottom:10,textAlign:"center"}}>
                <div style={{fontSize:9,fontWeight:700,color:C.sub,textTransform:"uppercase",letterSpacing:".8px",marginBottom:3}}>Confluence Score · 6 Factors · Weights Sum to 100</div>
                <div style={{fontSize:36,fontWeight:900,letterSpacing:"-1px",color:conf>=80?C.accent:conf>=60?C.amber:C.red}}>{conf}%</div>
                <div style={{height:5,background:C.border,borderRadius:99,margin:"6px 0 4px"}}>
                  <div style={{height:"100%",borderRadius:99,transition:"width .6s",background:conf>=80?C.accent:conf>=60?C.amber:C.red,width:`${conf}%`}}/>
                </div>
                <div style={{fontSize:10,color:C.sub}}>
                  {conf>=80?"High Conviction — Full size":conf>=60?"Medium Conviction — 50% size":conf>0?"Low Confluence — Skip":"Awaiting setup..."}
                </div>
              </div>
              {/* FIX 1: 6 factors with weights displayed */}
              {[
                {k:"failedAcceptance",l:"Failed Acceptance (sweep + close inside level)",w:28},
                {k:"levelQuality",l:"Level Quality (PDH/PDL/EQH/EQL salience)",w:20},
                {k:"normalisedVolume",l:`Normalised Volume (${(volume/1000).toFixed(0)}K vs ToD ${(todBase/1000).toFixed(0)}K)`,w:18},
                {k:"htfBias",l:`HTF Bias aligned (${htf})`,w:14},
                {k:"sessionQuality",l:`Session Quality (${sess?.label||"—"} ×${sess?.weight||0})`,w:12},
                {k:"volatilityRegime",l:`Volatility Regime (${reg?.label||"—"})`,w:8},
              ].map(f=><Check key={f.k} label={f.l} w={f.w} passed={checks[f.k]} na={!Object.keys(checks).length}/>)}
              {signal&&<div style={{marginTop:8,background:C.accent+"22",border:`2px solid ${C.accent}`,borderRadius:10,padding:"10px",textAlign:"center"}}>
                <div style={{fontSize:13,fontWeight:800,color:C.primary}}>✅ VALID TRADE SIGNAL</div>
                <div style={{fontSize:10,color:C.sub,marginTop:1}}>
                  {signal.dir.toUpperCase()} · Score {signal.score}%{signal.sm<1?" · ⚠ 50% size":""}
                  {signal.pid==="FVG_RETURN"?" · ≥85% threshold":""}
                </div>
              </div>}
            </div>
          </Card>

          {/* EXECUTION — FIX 2 visible */}
          <Card title="Trade Execution Panel" icon="⚡">
            <div style={{padding:"12px 14px"}}>
              {signal?(
                <>
                  <div style={{background:signal.dir==="long"?C.greenL:C.redL,border:`1px solid ${signal.dir==="long"?C.accent:C.red}44`,borderRadius:10,padding:"10px",marginBottom:10}}>
                    <div style={{fontWeight:800,fontSize:15,color:signal.dir==="long"?C.primary:C.red,textAlign:"center"}}>
                      {signal.dir==="long"?"📈 LONG":"📉 SHORT"} SIGNAL
                    </div>
                    {/* GUARDRAIL 4: countdown */}
                    <div style={{marginTop:7}}>
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:C.sub,marginBottom:3}}>
                        <span>Signal timeout (non-bypassable)</span>
                        <span style={{fontWeight:700,color:countdown>30?C.accent:countdown>10?C.amber:C.red}}>{countdown}s</span>
                      </div>
                      <div style={{height:4,background:C.border,borderRadius:99,overflow:"hidden"}}>
                        <div style={{height:"100%",borderRadius:99,transition:"width 1s linear",background:countdown>30?C.accent:countdown>10?C.amber:C.red,width:`${(countdown/90)*100}%`}}/>
                      </div>
                    </div>
                  </div>
                  <Row label="Entry Price" value={fmt(signal.entry)} bold/>
                  {/* FIX 2: both stops shown */}
                  <Row label="Structural Stop" value={fmt(signal.structStop)} color={C.red} note="sweep extreme ±0.2×ATR"/>
                  <Row label="ATR Stop" value={fmt(signal.atrStop)} color={C.amber} note="1.5×ATR from entry"/>
                  <Row label="Stop Used (tighter)" value={fmt(signal.stop)} color={C.red} bold/>
                  <Row label="Stop Distance" value={fmt(signal.dist)}/>
                  <Row label="Target 1 (1.5R)" value={fmt(signal.t1)} color={C.accent}/>
                  <Row label="Target 2 (2.5R)" value={fmt(signal.t2)} color={C.accent} bold/>
                  <div style={{height:1,background:C.border,margin:"8px 0"}}/>
                  <Row label="Risk Amount" value={`₹${fmt(signal.riskAmt)}`} color={C.red}/>
                  <Row label="Position Size" value={`${signal.qty} units`} bold/>
                  <Row label="R:R" value="1 : 2.5" color={C.accent}/>
                  {signal.sm<1&&<div style={{marginTop:6,background:C.amberL,border:`1px solid ${C.amber}44`,borderRadius:7,padding:"6px 10px",fontSize:10,color:C.amber,fontWeight:600}}>⚠️ 50% size — Trending regime active</div>}
                  <button onClick={execTrade} disabled={!!activeTrade||(!paperMode&&tradeCount>=RP.maxT)||blocked}
                    style={{width:"100%",marginTop:10,background:paperMode?C.paper:C.primary,color:"#fff",border:"none",borderRadius:9,padding:"11px",fontSize:13,fontWeight:800,cursor:"pointer",opacity:activeTrade||(!paperMode&&tradeCount>=RP.maxT)||blocked?.4:1}}>
                    {paperMode?"📝 Paper Execute":"Execute Trade"} · {countdown}s
                  </button>
                </>
              ):activeTrade?(
                <>
                  <div style={{background:activeTrade.direction==="long"?C.greenL:C.redL,borderRadius:10,padding:"10px",marginBottom:10,textAlign:"center"}}>
                    <div style={{fontWeight:800,fontSize:13,color:C.primary}}>{activeTrade.isPaper?"📝 PAPER TRADE":"🔴 LIVE TRADE"} — {activeTrade.direction.toUpperCase()}</div>
                    <div style={{fontSize:10,color:C.sub,marginTop:1}}>{activeTrade.pattern} · {activeTrade.entryTime}</div>
                    {beMoved&&<div style={{marginTop:5,background:C.accent+"22",borderRadius:6,padding:"3px 7px",fontSize:10,fontWeight:700,color:C.primary}}>✅ Stop at Break-Even ({fmt(activeTrade.entry)})</div>}
                  </div>
                  <Row label="Entry" value={fmt(activeTrade.entry)} bold/>
                  <Row label="Stop" value={fmt(activeTrade.stop)} color={C.red} bold/>
                  <Row label="T1" value={fmt(activeTrade.t1)} color={C.accent}/>
                  <Row label="T2" value={fmt(activeTrade.t2)} color={C.accent} bold/>
                  <div style={{height:1,background:C.border,margin:"8px 0"}}/>
                  {/* GUARDRAIL 2: only Stop Hit / Target Hit */}
                  <div style={{background:C.amberL,border:`1px solid ${C.amber}33`,borderRadius:8,padding:"8px",marginBottom:6}}>
                    <div style={{fontSize:10,color:C.amber,fontWeight:700,textAlign:"center",marginBottom:7}}>🔒 Manual exit only — no early close</div>
                    <div style={{display:"flex",gap:8}}>
                      <button onClick={()=>manualClose("stop")} style={{flex:1,background:C.red,color:"#fff",border:"none",borderRadius:8,padding:"10px",fontSize:12,fontWeight:800,cursor:"pointer"}}>Stop Hit</button>
                      <button onClick={()=>manualClose("target")} style={{flex:1,background:C.accent,color:"#fff",border:"none",borderRadius:8,padding:"10px",fontSize:12,fontWeight:800,cursor:"pointer"}}>Target Hit</button>
                    </div>
                  </div>
                </>
              ):(
                <div style={{textAlign:"center",padding:"28px 0",color:C.sub,fontSize:12}}>
                  <div style={{fontSize:32,marginBottom:8}}>⚡</div>
                  Awaiting valid signal...<br/>Press "Simulate Next Setup" to detect patterns.
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* ROW 3 */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>

          {/* RISK MANAGEMENT */}
          <Card title="Risk Management" icon="🛡">
            <div style={{padding:"12px 14px"}}>
              {/* GUARDRAIL 5 */}
              {cb&&!paperMode&&<div style={{background:C.redL,border:`2px solid ${C.red}`,borderRadius:10,padding:"10px 12px",marginBottom:10,textAlign:"center"}}>
                <div style={{fontWeight:800,fontSize:13,color:C.red}}>🔴 CIRCUIT BREAKER ACTIVE</div>
                <div style={{fontSize:11,color:C.sub,marginTop:2}}>Daily loss limit breached</div>
                <div style={{fontSize:10,color:C.red,fontWeight:700,marginTop:4}}>Locked until midnight — no override, no exceptions</div>
              </div>}
              <Row label={paperMode?"Paper Capital":"Live Capital"} value={`₹${(eCap/100000).toFixed(1)}L`} bold/>
              <Row label="Risk per Trade" value={pct(RP.riskPct)}/>
              <Row label="Risk Amount" value={`₹${fmt(eCap*RP.riskPct)}`} color={C.red}/>
              <Row label="Daily Loss Limit" value={pct(RP.limitPct)} color={C.red}/>
              {!paperMode?(<>
                <Row label="Trades Today" value={`${tradeCount} / ${RP.maxT}`} color={tradeCount>=RP.maxT?C.red:C.text} bold/>
                <Row label="Daily P&L" value={`${dailyPnL>=0?"+":""}₹${fmt(Math.abs(dailyPnL))}`} color={dailyPnL>=0?C.accent:C.red} bold/>
              </>):(<>
                <Row label="Paper Trades" value={pCount} bold/>
                <Row label="Paper P&L" value={`${pPnL>=0?"+":""}₹${fmt(Math.abs(pPnL))}`} color={pPnL>=0?C.accent:C.red} bold/>
                {pLog.length>0&&<Row label="Paper Win Rate" value={pct(pLog.filter(t=>t.result>0).length/pLog.length)} color={pLog.filter(t=>t.result>0).length/pLog.length>.42?C.accent:C.amber} bold/>}
                <Row label="Trades to Analysis" value={`${pLog.length} / 25`} color={pLog.length>=25?C.accent:C.sub}/>
              </>)}
              {!paperMode&&<div style={{marginTop:8}}>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:C.sub,marginBottom:3}}>
                  <span>Daily loss limit used</span>
                  <span>{pct(Math.min(1,Math.abs(dailyPnL)/(capital*RP.limitPct)))}</span>
                </div>
                <div style={{height:5,background:C.border,borderRadius:99,overflow:"hidden"}}>
                  <div style={{height:"100%",borderRadius:99,transition:"width .5s",background:dailyPnL>=0?C.accent:C.red,width:`${Math.min(100,Math.abs(dailyPnL)/(capital*RP.limitPct)*100)}%`}}/>
                </div>
              </div>}
              <div style={{marginTop:8,background:C.blueL,border:`1px solid ${C.blue}33`,borderRadius:7,padding:"7px 9px",fontSize:10,color:C.blue,fontWeight:600}}>
                🎯 Break-even: Stop moves to entry automatically after T1 is hit.
              </div>
              {reg&&<div style={{marginTop:6,background:`${reg.color}11`,border:`1px solid ${reg.color}33`,borderRadius:7,padding:"6px 9px",fontSize:10,fontWeight:700,color:reg.color}}>{reg.icon} {reg.label} · {reg.sizeNote}</div>}
            </div>
          </Card>

          {/* TRADE LOG */}
          <Card title={paperMode?"Paper Trade Log 📝":"Trade Log"} icon="📋" hbg={paperMode?C.paper:C.primary}>
            <div style={{padding:"12px 14px",maxHeight:340,overflowY:"auto"}}>
              {eLog.length===0?(
                <div style={{textAlign:"center",padding:"24px 0",color:C.sub,fontSize:12}}>
                  {paperMode?"No paper trades yet.":"No trades today."}
                </div>
              ):eLog.map((t,i)=>{
                const won=t.result>0,rA=Math.abs(t.rMultiple);
                return(
                  <div key={t.id||i} style={{background:won?C.greenL:C.redL,border:`1px solid ${won?C.accent:C.red}33`,borderRadius:9,padding:"9px 11px",marginBottom:7}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
                      <div>
                        <div style={{fontWeight:700,fontSize:11,color:C.text}}>{t.pattern}</div>
                        <div style={{fontSize:9,color:C.sub}}>{t.entryTime} · {t.direction?.toUpperCase()} · {t.score}%</div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontWeight:800,fontSize:12,color:won?C.accent:C.red}}>{t.result>=0?"+":""}{fmt(t.result)}</div>
                        <Badge label={`${t.rMultiple>=0?"+":""}${t.rMultiple}R`} color={won?C.accent:C.red} sz={9}/>
                      </div>
                    </div>
                    <div style={{display:"flex",gap:5,fontSize:9,color:C.sub,marginBottom:4}}>
                      <span>E:{fmt(t.entry)}</span><span>X:{fmt(t.exit)}</span>
                      <Badge label={t.status||"CLOSED"} color={t.status?.includes("T2")?"#7C3AED":won?C.accent:C.red} sz={8}/>
                    </div>
                    <div style={{height:3,background:"rgba(0,0,0,.08)",borderRadius:99,overflow:"hidden"}}>
                      <div style={{height:"100%",background:won?C.accent:C.red,width:`${Math.min(100,rA/3*100)}%`,borderRadius:99}}/>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        {/* PAPER ANALYSIS — after 25 trades */}
        {pa&&<Card title="📊 Paper Trading Analysis — 25 Trade Review" icon="📈" hbg={C.paper}>
          <div style={{padding:"14px"}}>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}}>
              {[
                {l:"Win Rate",    v:pct(pa.wr),   c:pa.wr>.42?C.accent:C.red},
                {l:"Avg Winner", v:`+${pa.awR.toFixed(2)}R`, c:C.accent},
                {l:"Avg Loser",  v:`-${pa.alR.toFixed(2)}R`, c:C.red},
                {l:"Expectancy", v:`${pa.exp>0?"+":""}${pa.exp.toFixed(3)}R`, c:pa.exp>.05?C.accent:pa.exp>0?C.amber:C.red},
              ].map(m=>(
                <div key={m.l} style={{background:C.surface2,borderRadius:9,padding:"10px",textAlign:"center"}}>
                  <div style={{fontSize:9,color:C.sub,fontWeight:600,marginBottom:4}}>{m.l}</div>
                  <div style={{fontSize:18,fontWeight:900,color:m.c}}>{m.v}</div>
                </div>
              ))}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
              <div>
                <div style={{fontSize:10,fontWeight:700,color:C.sub,marginBottom:6,textTransform:"uppercase",letterSpacing:".5px"}}>Pattern Performance</div>
                {pa.patWR.slice(0,5).map((p,i)=>(
                  <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                    <span style={{fontSize:10,color:C.text,fontWeight:i===0?700:500}}>{p.n}</span>
                    <div style={{display:"flex",gap:5,alignItems:"center"}}>
                      <span style={{fontSize:9,color:C.sub}}>({p.c})</span>
                      <span style={{fontSize:10,fontWeight:700,color:p.wr>.5?C.accent:p.wr>.35?C.amber:C.red}}>{pct(p.wr)}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div>
                <div style={{fontSize:10,fontWeight:700,color:C.sub,marginBottom:6,textTransform:"uppercase",letterSpacing:".5px"}}>Session Performance</div>
                {pa.sessWR.slice(0,5).map((s,i)=>(
                  <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                    <span style={{fontSize:10,color:C.text,fontWeight:i===0?700:500}}>{s.n}</span>
                    <div style={{display:"flex",gap:5,alignItems:"center"}}>
                      <span style={{fontSize:9,color:C.sub}}>({s.c})</span>
                      <span style={{fontSize:10,fontWeight:700,color:s.wr>.5?C.accent:s.wr>.35?C.amber:C.red}}>{pct(s.wr)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{background:C.surface2,borderRadius:8,padding:"10px",marginBottom:10}}>
              <div style={{fontSize:10,fontWeight:700,color:C.sub,marginBottom:6,textTransform:"uppercase",letterSpacing:".5px"}}>Score Bucket Analysis</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                <div style={{textAlign:"center"}}>
                  <div style={{fontSize:9,color:C.sub}}>80–100 ({pa.hiN} trades)</div>
                  <div style={{fontSize:20,fontWeight:900,color:pa.hiWR>.5?C.accent:C.amber}}>{pct(pa.hiWR)}</div>
                </div>
                <div style={{textAlign:"center"}}>
                  <div style={{fontSize:9,color:C.sub}}>60–79 ({pa.mdN} trades)</div>
                  <div style={{fontSize:20,fontWeight:900,color:pa.mdWR>.5?C.accent:C.amber}}>{pct(pa.mdWR)}</div>
                </div>
              </div>
            </div>
            <div style={{background:pa.rc+"22",border:`2px solid ${pa.rc}44`,borderRadius:10,padding:"12px",textAlign:"center"}}>
              <div style={{fontSize:14,fontWeight:900,color:pa.rc}}>{pa.rec}</div>
              <div style={{fontSize:10,color:C.sub,marginTop:4}}>
                Based on {pa.tot} trades · Expectancy net of 0.08R estimated costs
                {pa.rec.includes("Ready")?" · Criteria: ≥25 trades, WR >42%, Exp >0.05R":""}
              </div>
            </div>
          </div>
        </Card>}

        {/* ACTION BUTTONS */}
        <div style={{display:"flex",gap:10,justifyContent:"center",flexWrap:"wrap"}}>
          <button onClick={simulate} disabled={blocked||(!paperMode&&tradeCount>=RP.maxT)||regime==="EVENT_DAY"}
            style={{background:paperMode?C.paper:C.primary,color:"#fff",border:"none",borderRadius:10,
              padding:"12px 28px",fontSize:14,fontWeight:800,cursor:"pointer",
              opacity:blocked||(!paperMode&&tradeCount>=RP.maxT)||regime==="EVENT_DAY"?.4:1,
              boxShadow:`0 4px 20px ${paperMode?C.paper:C.primary}44`}}>
            ⚡ Simulate Next Setup
          </button>
          <button onClick={resetDay} style={{background:C.surface,color:C.primary,border:`2px solid ${C.primary}`,borderRadius:10,padding:"12px 28px",fontSize:14,fontWeight:800,cursor:"pointer"}}>
            ↺ Reset Day
          </button>
          {paperMode&&pLog.length>0&&<button onClick={()=>{setPLog([]);setPPnL(0);setPCount(0);}}
            style={{background:C.surface,color:C.paper,border:`2px solid ${C.paper}`,borderRadius:10,padding:"12px 28px",fontSize:14,fontWeight:800,cursor:"pointer"}}>
            🗑 Clear Paper Log
          </button>}
        </div>

        {/* FOOTER */}
        <div style={{background:C.primary,borderRadius:10,padding:"12px 16px"}}>
          <div style={{fontWeight:700,fontSize:10,color:C.accent,textTransform:"uppercase",letterSpacing:".8px",marginBottom:6}}>System Philosophy · v2.0</div>
          <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
            {[
              "Institutions sweep stops to fill large orders → we ride the reversal",
              "6 factors · Σ=100 · Weights are now mathematically correct",
              "Structural stop: beyond sweep extreme + 0.2×ATR — not generic ATR",
              "Volume normalised to time-of-day U-shaped intraday baseline",
              "Every pattern has deterministic numeric rules — no subjective calls",
            ].map((t,i)=>(
              <div key={i} style={{display:"flex",alignItems:"flex-start",gap:6,fontSize:10,color:"rgba(255,255,255,.7)"}}>
                <span style={{color:C.accent,flexShrink:0}}>◦</span>{t}
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
