import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validOkxHistory,okxPerformanceReport} from '../host/okx-history.mjs';
const hasSwift=process.platform==='darwin'&&spawnSync('swiftc',['--version']).status===0;
test('native history uses signed fixed GET pagination, exact text, bounded coverage and closed partial failures',{skip:!hasSwift},()=>{
 const dir=mkdtempSync(join(tmpdir(),'along-okx-history-'));
 try{
 const source=fileURLToPath(new URL('../ios/AlongHealth/Sources/OKXDeviceClient.swift',import.meta.url)),harness=join(dir,'Check.swift');
 writeFileSync(harness,String.raw`
import Foundation
import CryptoKit
private let clock=Date(timeIntervalSince1970:1795000000)
private let credentials=OKXDeviceCredentials(apiKey:"synthetic-key",secretKey:"synthetic-secret",passphrase:"synthetic-pass")
private actor Fixture{
 let mode:String;var calls=0;var queries=[[String:String]]();var perType=[String:Int]();var billPages=0;var waiting=false
 init(_ mode:String){self.mode=mode}
 static func typesIndex(_ type:String)->Int{["SPOT","MARGIN","SWAP","FUTURES","OPTION","EVENTS"].firstIndex(of:type)!}
 func isWaiting()->Bool{waiting}
 func metadata()->(Int,[[String:String]]){(calls,queries)}
 func fill(_ id:String,_ type:String)->[String:String]{["billId":id,"tradeId":"123456789012345678901234567890","ordId":"123456789012345678901234567891","instType":type,"instId":"BTC-USDT","side":"buy","posSide":"net","fillPx":"12345.123456789012345678901234","fillSz":"0.00000001","fillPnl":"0","fee":"-0.000000000000000000000001","feeCcy":"BTC","ts":"1795000000000","tag":"alpha_1"]}
 func request(_ request:URLRequest,_ limit:Int)async throws->(Data,HTTPURLResponse){
  calls+=1;let url=request.url!,path=url.path
  precondition(url.host=="openapi.okx.com"&&url.scheme=="https"&&request.httpMethod=="GET"&&request.httpBody==nil)
  let q=Dictionary(uniqueKeysWithValues:(URLComponents(url:url,resolvingAgainstBaseURL:false)!.queryItems ?? []).map{($0.name,$0.value!)})
  if path != "/api/v5/public/time"{
   let stamp=request.value(forHTTPHeaderField:"OK-ACCESS-TIMESTAMP")!
   let target=path+(url.query.map{"?"+$0} ?? "")
   let signature=HMAC<SHA256>.authenticationCode(for:Data((stamp+"GET"+target).utf8),using:SymmetricKey(data:Data(credentials.secretKey.utf8)))
   precondition(request.value(forHTTPHeaderField:"OK-ACCESS-SIGN")==Data(signature).base64EncodedString(),"HMAC must include the exact encoded query")
  }
  var rows:[[String:Any]]=[]
  switch path{
  case "/api/v5/public/time":rows=[["ts":"1795000000000"]]
  case "/api/v5/account/config":rows=[["perm":"read_only"]]
  case "/api/v5/account/balance":rows=[["totalEq":"42.01","details":[["ccy":"BTC"]]]]
  case "/api/v5/account/positions":rows=[]
  case "/api/v5/trade/fills-history","/api/v5/account/bills-archive":
   queries.append(q);precondition(q["limit"]=="100"&&q["begin"] != nil&&q["end"]=="1795000000000")
   precondition(Set(q.keys).isSubset(of:["limit","begin","end","after","instType"]))
   if mode=="cancel"{waiting=true;try await Task.sleep(nanoseconds:5_000_000_000)}
   if path=="/api/v5/trade/fills-history"{
    let type=q["instType"]!;perType[type,default:0]+=1;let page=perType[type]!
    if mode=="budget"{
     let base=990000-Fixture.typesIndex(type)*10000-(page-1)*100
     rows=(0..<100).map{n in var r=fill(String(repeating:"9",count:58)+String(format:"%06d",base-n),type);r["ordId"]=String(repeating:"8",count:64);r["tradeId"]=String(repeating:"7",count:64);r["instId"]=String(repeating:"X",count:80);r["tag"]=String(repeating:"x",count:32);r["feeCcy"]=String(repeating:"Y",count:24);for key in ["fillPx","fillSz","fillPnl","fee"]{r[key]=String(repeating:"9",count:36)+"."+String(repeating:"8",count:24)};return r}
    }
    if mode=="one"&&type=="SPOT"{var r=fill("99999999999999999999999999999999999999",type);r["tradeId"]="-1";r.removeValue(forKey:"fillPnl");rows=[r.merging(["apiKey":"must-not-persist"],uniquingKeysWith:{$1})]}
    if mode=="unavailable"&&type=="OPTION"{throw URLError(.cannotConnectToHost)}
    if ["page","repeated","truncated"].contains(mode)&&type=="SPOT"{
     let base=1000-(page-1)*100
     if mode=="page"&&page==2{rows=[fill("900",type),fill("899",type)]}
     else if mode=="repeated"&&page==2{rows=[fill("901",type)]}
     else{rows=(0..<100).map{fill(String(base-$0),type)}}
    }
    if mode=="unordered"&&type=="SPOT"{rows=[fill("1",type),fill("2",type)]}
    if mode=="malformed"&&type=="SPOT"{var r=fill("1",type);r["fee"]="not-a-number";rows=[r]}
    if mode=="too-many"&&type=="SPOT"{rows=(0..<101).map{fill(String(1000-$0),type)}}
    if mode=="duplicate"&&type=="SPOT"{rows=[fill("2",type),fill("2",type),fill("1",type)]}
    if mode=="conflicting-duplicate"&&type=="SPOT"{var conflict=fill("2",type);conflict["fee"]="-9";rows=[fill("2",type),conflict]}
   }else{
    precondition(q["instType"]==nil)
    if mode=="budget"{
     billPages+=1;let base=990000-(billPages-1)*100
     rows=(0..<100).map{n in var r=["billId":String(repeating:"7",count:58)+String(format:"%06d",base-n),"instType":"SWAP","instId":String(repeating:"X",count:80),"type":"2","subType":"1","ccy":String(repeating:"Y",count:24),"pnl":"","fee":"","balChg":"","sz":"","px":"","ts":"1795000000000"];for key in ["pnl","fee","balChg","sz","px"]{r[key]=String(repeating:"9",count:36)+"."+String(repeating:"8",count:24)};return r}
    }
    if mode=="one"{rows=[["billId":"99999999999999999999999999999999999999","instType":"SPOT","instId":"BTC-USDT","type":"2","subType":"1","ccy":"BTC","pnl":"","fee":"-0.000000000000000000000001","balChg":"0.1","sz":"0.1","px":"12345.123456789012345678901234","ts":"1795000000000"]]}
   }
  default:fatalError("unexpected external endpoint")
  }
  return(try JSONSerialization.data(withJSONObject:["code":"0","data":rows,"msg":"must-not-persist"]),HTTPURLResponse(url:url,statusCode:200,httpVersion:nil,headerFields:nil)!)
 }
}
private func collect(_ mode:String)async throws->(OKXDeviceObservation,Fixture){let f=Fixture(mode);let c=OKXDeviceClient(transport:{request,limit in try await f.request(request,limit)},now:{clock},historyDelayNanoseconds:0);return(try await c.collect(site:.global,credentials:credentials),f)}
@main private struct Check{
 static func main()async throws{
  let(empty,fixture)=try await collect("empty");let h=empty.history!;precondition(h.streams.count==7&&h.streams.allSatisfy{$0.status=="complete"&&$0.pages==1}&&h.fills.isEmpty&&h.bills.isEmpty)
  let(calls,queries)=await fixture.metadata();precondition(calls==11&&queries.count==7&&Set(queries.map{$0["begin"]!}).count==1)
  let(one,_)=try await collect("one");precondition(one.history!.fills[0]["billId"]=="99999999999999999999999999999999999999"&&one.history!.fills[0]["fee"]=="-0.000000000000000000000001"&&one.history!.fills[0]["fillPnl"]=="")
  precondition(one.history!.fills[0]["tradeId"]=="-1")
  let obj=try one.history!.dictionary();precondition(OKXDeviceHistory.decode(obj)==one.history)
  try JSONSerialization.data(withJSONObject:obj).write(to:URL(fileURLWithPath:CommandLine.arguments[1]))
  let encoded=String(data:try JSONSerialization.data(withJSONObject:obj),encoding:.utf8)!;precondition(!encoded.contains("must-not-persist") && !encoded.contains("apiKey"))
  var bad=obj;bad["privateKey"]="hidden";precondition(OKXDeviceHistory.decode(bad)==nil)
  var streams=bad["streams"] as! [[String:Any]];streams[0]["unexpected"]="hidden";bad=obj;bad["streams"]=streams;precondition(OKXDeviceHistory.decode(bad)==nil)
  let(paged,p)=try await collect("page");precondition(paged.history!.fills.count==102&&paged.history!.streams[0].pages==2&&paged.history!.streams[0].status=="complete");let(_,pq)=await p.metadata();precondition(pq[1]["after"]=="901")
  let(duplicates,_)=try await collect("duplicate");precondition(duplicates.history!.fills.count==2)
  let(truncated,_)=try await collect("truncated");precondition(truncated.history!.fills.count==500&&truncated.history!.streams[0].status=="truncated"&&truncated.history!.streams[0].pages==5)
  for mode in ["repeated","unordered","malformed","too-many","unavailable","conflicting-duplicate"]{let(value,_)=try await collect(mode);precondition(value.summary.tradingEquityUsd==42.01&&value.history!.streams.contains{$0.status=="unavailable"},"history failure cannot fabricate complete-empty or destroy summary")}
  let(budget,_)=try await collect("budget");let budgetData=try JSONEncoder().encode(budget.history!);let budgetObject=try budget.history!.dictionary();precondition(budgetData.count<=2*1024*1024&&budget.history!.fills.count+budget.history!.bills.count<5000&&OKXDeviceHistory.decode(budgetObject) != nil)
  let f=Fixture("cancel"),c=OKXDeviceClient(transport:{request,limit in try await f.request(request,limit)},now:{clock},historyDelayNanoseconds:0)
  let task=Task{try await c.collect(site:.global,credentials:credentials)}
  for _ in 0..<200{if await f.isWaiting(){break};try await Task.sleep(nanoseconds:1_000_000)}
  task.cancel();do{_=try await task.value;fatalError("cancelled history must not commit summary/history as connected")}catch{precondition(error as?OKXDeviceClientError == .cancelled)}
  print("history HMAC-query, exact decimal/id, fixed window, pagination, duplicate, malformed, bounded partial and cancellation passed")
 }
}
`);
 const exe=join(dir,'check');execFileSync('swiftc',['-swift-version','5','-parse-as-library','-module-cache-path',join(dir,'module-cache'),source,harness,'-o',exe],{timeout:90000,maxBuffer:3_000_000});
 const wire=join(dir,'native-history.json');const output=execFileSync(exe,[wire],{encoding:'utf8',timeout:40000,maxBuffer:2_000_000});const observed=JSON.parse(readFileSync(wire,'utf8'));assert.equal(validOkxHistory(observed),true);const report=okxPerformanceReport(observed);assert.equal(report.totals.fills,1);assert.equal(report.totals.bills,1);assert.equal(report.groups.fills[0].feeCashflow,'-0.000000000000000000000001');assert.match(output,/history HMAC-query, exact decimal\/id, fixed window, pagination, duplicate, malformed, bounded partial and cancellation passed/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
