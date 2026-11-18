import {createHash} from 'node:crypto';

export const OKX_HISTORY_TYPES=['SPOT','MARGIN','SWAP','FUTURES','OPTION','EVENTS'];
const FILL_KEYS=['billId','tradeId','ordId','instType','instId','side','posSide','fillPx','fillSz','fillPnl','fee','feeCcy','ts','tag'];
const BILL_KEYS=['billId','instType','instId','type','subType','ccy','pnl','fee','balChg','sz','px','ts'];
const DECIMAL=/^-?[0-9]{1,36}(?:\.[0-9]{1,24})?$/;
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>plain(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const text=(x,re)=>typeof x==='string'&&re.test(x);
const numeric=x=>x===''||text(x,DECIMAL);
const date=x=>typeof x==='string'&&x.length<=40&&/^\d{4}-\d\d-\d\dT/.test(x)&&Number.isFinite(Date.parse(x));
const currency=x=>text(x,/^[A-Z0-9]{1,24}$/);
const identifier=x=>text(x,/^[A-Z0-9_-]{1,80}$/);
const id=x=>text(x,/^[0-9]{1,64}$/);
const tradeId=x=>x===''||text(x,/^-?[0-9]{1,64}$/);
const optionalId=x=>x===''||id(x);
const timestamp=(x,start,end)=>text(x,/^[0-9]{13}$/)&&Number(x)>=start&&Number(x)<=end;
const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':plain(x)?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
export const okxDataDigest=(summary,history)=>createHash('sha256').update(history===undefined
  ?JSON.stringify([summary.tradingEquityUsd,summary.assetCount,summary.positionCount])
  :canonical({summary,history})).digest('hex');
export const hasOkxHistory=h=>!!h&&(h.fills.length>0||h.bills.length>0||h.streams.some(s=>s.status==='complete'));

/** Exact normalized private contract. Provider responses, URLs and secrets are never accepted. */
export function validOkxHistory(h,observedAt=h?.windowEnd){
  if(!exact(h,['version','windowStart','windowEnd','streams','fills','bills'])||h.version!==1||!date(h.windowStart)||!date(h.windowEnd)||!date(observedAt))return false;
  const start=Date.parse(h.windowStart),end=Date.parse(h.windowEnd);
  if(start>=end||end-start>94*86400000||end>Date.parse(observedAt)+1000||!Array.isArray(h.streams)||h.streams.length!==7||
    !Array.isArray(h.fills)||h.fills.length>3000||!Array.isArray(h.bills)||h.bills.length>2000||Buffer.byteLength(JSON.stringify(h))>2*1024*1024)return false;
  const streamKeys=new Set();
  for(const s of h.streams){
    if(!exact(s,['kind','instType','status','reason','pages'])||!['fills','bills'].includes(s.kind)||
      !(s.kind==='fills'?OKX_HISTORY_TYPES.includes(s.instType):s.instType==='ALL')||
      !['complete','truncated','unavailable'].includes(s.status)||
      s.reason!==({complete:'none',truncated:'page_limit',unavailable:'api_unavailable'})[s.status]||
      !Number.isSafeInteger(s.pages)||s.pages<0||s.pages>(s.kind==='fills'?5:20)||s.status!=='unavailable'&&s.pages<1)return false;
    const key=s.kind+':'+s.instType;if(streamKeys.has(key))return false;streamKeys.add(key);
  }
  const seenFills=new Set(),seenBills=new Set(),typeCounts=new Map();
  for(const f of h.fills){
    if(!exact(f,FILL_KEYS)||!FILL_KEYS.every(k=>typeof f[k]==='string')||!id(f.billId)||!tradeId(f.tradeId)||!optionalId(f.ordId)||
      !OKX_HISTORY_TYPES.includes(f.instType)||!identifier(f.instId)||!['buy','sell'].includes(f.side)||!['','net','long','short'].includes(f.posSide)||
      !['fillPx','fillSz','fillPnl','fee'].every(k=>numeric(f[k]))||!(f.feeCcy===''||currency(f.feeCcy))||
      !timestamp(f.ts,start,end)||!text(f.tag,/^[A-Za-z0-9_-]{0,32}$/)||seenFills.has(f.billId))return false;
    seenFills.add(f.billId);typeCounts.set(f.instType,(typeCounts.get(f.instType)??0)+1);
  }
  if([...typeCounts.values()].some(n=>n>500))return false;
  for(const b of h.bills){
    if(!exact(b,BILL_KEYS)||!BILL_KEYS.every(k=>typeof b[k]==='string')||!id(b.billId)||!(b.instType===''||OKX_HISTORY_TYPES.includes(b.instType))||
      !(b.instId===''||identifier(b.instId))||!text(b.type,/^[0-9]{1,4}$/)||!text(b.subType,/^[0-9]{0,4}$/)||!currency(b.ccy)||
      !['pnl','fee','balChg','sz','px'].every(k=>numeric(b[k]))||!timestamp(b.ts,start,end)||seenBills.has(b.billId))return false;
    seenBills.add(b.billId);
  }
  return true;
}

function decimal(s){
  const negative=s.startsWith('-'),[whole,fraction='']=s.replace(/^-/,'').split('.');
  return {n:BigInt((negative?'-':'')+whole+fraction),scale:fraction.length};
}
function add(a,b){const scale=Math.max(a.scale,b.scale);return {n:a.n*10n**BigInt(scale-a.scale)+b.n*10n**BigInt(scale-b.scale),scale};}
function format(d){const negative=d.n<0n,raw=(negative?-d.n:d.n).toString().padStart(d.scale+1,'0');
  const value=d.scale?raw.slice(0,-d.scale)+'.'+raw.slice(-d.scale):raw;
  const clean=value.includes('.')?value.replace(/0+$/,'').replace(/\.$/,''):value;return (negative&&clean!=='0'?'-':'')+clean;}
function total(rows,field){if(rows.some(r=>r[field]===''))return null;return format(rows.reduce((v,r)=>add(v,decimal(r[field])),{n:0n,scale:0}));}
const net=(a,b)=>a===null||b===null?null:format(add(decimal(a),decimal(b)));
function group(rows,fields){const result=new Map();for(const r of rows){const k=JSON.stringify(fields.map(f=>r[f]));if(!result.has(k))result.set(k,[]);result.get(k).push(r);}return [...result].sort(([a],[b])=>a.localeCompare(b)).map(([,r])=>r);}
const distinctOrders=rows=>new Set(rows.filter(r=>r.ordId).map(r=>r.instType+':'+r.instId+':'+r.ordId)).size;

/** Arithmetic is deterministic, exact, and per currency. This is observed evidence, not a profit promise. */
export function okxPerformanceReport(history){
  if(!validOkxHistory(history))throw new Error('invalid_okx_history');
  const {fills,bills}=history,billIds=new Set(bills.map(r=>r.billId));
  const fillGroups=group(fills,['instType','instId','feeCcy']).map(rows=>({instType:rows[0].instType,instId:rows[0].instId,feeCcy:rows[0].feeCcy,
    fillCount:rows.length,orderCount:distinctOrders(rows),buyCount:rows.filter(r=>r.side==='buy').length,sellCount:rows.filter(r=>r.side==='sell').length,
    feeCashflow:rows[0].feeCcy?total(rows,'fee'):null,missingValues:rows.filter(r=>!r.fee||!r.feeCcy).length}));
  const billGroups=group(bills,['instType','instId','ccy']).map(rows=>{
    const trades=rows.filter(r=>r.type==='2'&&['SWAP','FUTURES','OPTION'].includes(r.instType)),funding=rows.filter(r=>r.type==='8'),other=rows.filter(r=>!trades.includes(r)&&r.type!=='8');
    const derivative=['SWAP','FUTURES','OPTION'].includes(rows[0].instType);
    const tradePnl=derivative?total(trades,'pnl'):null,tradeFee=total(rows.filter(r=>r.type==='2'),'fee');
    return {instType:rows[0].instType,instId:rows[0].instId,ccy:rows[0].ccy,billCount:rows.length,tradePnl,tradeFee,tradeNet:net(tradePnl,tradeFee),
      fundingCashflow:total(funding,'balChg'),otherCashflow:total(other,'balChg'),otherCount:other.length,
      missingValues:trades.filter(r=>!r.pnl||!r.fee).length+funding.filter(r=>!r.balChg).length+other.filter(r=>!r.balChg).length};
  });
  const groupsTruncated=fillGroups.length>100||billGroups.length>100;
  const complete=history.streams.every(s=>s.status==='complete')&&!groupsTruncated;
  const matchedFillCount=fills.filter(r=>billIds.has(r.billId)).length;
  const limits=[
    'Window filters use provider generation/balance-update timestamps; boundary fills and bills may not match.',
    'Amounts stay in their original currency. USD, USDT and other currencies are never combined or converted.',
    'Fill fee cashflows and bill trade fees are alternative evidence: never add both.',
    'tradeNet is observed ordinary derivative trade pnl plus its fee, not total account profit. Funding cashflow is separate; other cashflows are not profit.',
    'Spot/margin cashflows do not establish realized profit without opening cost basis. No ROI, drawdown, Sharpe ratio or trade win rate is established.',
    'Instrument groups and provider tags do not establish user strategy attribution; actual strategy rules and mappings are still required.',
    'Example rows are a bounded sample, not the full collected history. Missing numeric fields are unknown, not zero.',
  ];
  if(!complete)limits.unshift('Coverage is partial: unavailable or truncated streams/groups cannot establish complete period performance.');
  if(fillGroups.some(r=>r.missingValues)||billGroups.some(r=>r.missingValues))limits.push('Some numeric values or fee currencies are missing; affected totals remain null.');
  const report={version:1,windowStart:history.windowStart,windowEnd:history.windowEnd,
    coverage:{complete,streams:history.streams,fillCount:fills.length,billCount:bills.length,matchedFillCount,unmatchedFillCount:fills.length-matchedFillCount,groupsTruncated},
    totals:{fills:fills.length,orders:distinctOrders(fills),bills:bills.length,buys:fills.filter(r=>r.side==='buy').length,sells:fills.filter(r=>r.side==='sell').length},
    groups:{fills:fillGroups.slice(0,100),bills:billGroups.slice(0,100)},sampleFills:fills.slice(0,10),sampleBills:bills.slice(0,10),limitations:limits};
  if(Buffer.byteLength(JSON.stringify(report))>220000)throw new Error('okx_report_too_large');
  return report;
}
