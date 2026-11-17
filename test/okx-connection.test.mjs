import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync,statSync,chmodSync,copyFileSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {createOkxConnection,OkxConnectionError} from '../host/okx-connection.mjs';

const CREDENTIALS={apiKey:'synthetic-key-A',secretKey:'synthetic-secret-A',passphrase:'synthetic-passphrase-A'};
const USER='u_00112233',GOAL='g_44556677',NOW=1_794_953_600_000,SERVER=NOW+50_000;
const json=data=>new Response(JSON.stringify({code:'0',msg:'',data}),{headers:{'Content-Type':'application/json'}});
function fixture(t,over={}){
  const dir=mkdtempSync(join(tmpdir(),'along-okx-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const calls=[],state={perm:'read_only',equity:'1234.56',details:[{ccy:'BTC'},{ccy:'USDT'}],positions:[{pos:'0.2'},{pos:'-1'},{pos:'0'}],now:NOW,...over};
  const fetchImpl=async(url,options)=>{
    calls.push({url,options});
    const path=new URL(url).pathname;
    if(path==='/api/v5/public/time')return json([{ts:String(SERVER)}]);
    if(path==='/api/v5/account/config')return json([{perm:state.perm,uid:'never-return-this-private-id'}]);
    if(path==='/api/v5/account/balance')return json([{totalEq:state.equity,details:state.details}]);
    if(path==='/api/v5/account/positions')return json(state.positions);
    throw Error('unexpected path');
  };
  const make=(options={})=>createOkxConnection({dir,fetchImpl,now:()=>state.now,...options});
  const handle=(connection,input,extra={})=>connection.handle({userId:USER,goalId:GOAL,input,...extra});
  const connect=(connection,input={},extra={})=>handle(connection,{action:'connect',site:'global',credentials:CREDENTIALS,...input},extra);
  const vaultFiles=()=>readdirSync(dir).filter(name=>name.endsWith('.json'));
  return {dir,calls,state,fetchImpl,make,handle,connect,vaultFiles};
}
async function safeError(promise,code){
  await assert.rejects(promise,error=>{
    assert.ok(error instanceof OkxConnectionError);assert.equal(error.code,code);
    assert.doesNotMatch(error.message,/synthetic|remote-secret|never-return|private-id|account\/config/);
    assert.equal(error.cause,undefined);return true;
  });
}

test('connect verifies exact Read permission before signed official GETs, returns only the trading summary, and encrypts disk state',async t=>{
  const f=fixture(t),connection=f.make();
  assert.deepEqual(await f.handle(connection,{action:'status'}),{provider:'okx',state:'disconnected'});
  const result=await f.connect(connection);
  assert.deepEqual(result,{provider:'okx',state:'connected',lastSyncedAt:new Date(NOW).toISOString(),summary:{tradingEquityUsd:1234.56,assetCount:2,positionCount:2}});
  assert.equal(f.calls.length,4);
  assert.deepEqual(f.calls.map(call=>new URL(call.url).pathname),['/api/v5/public/time','/api/v5/account/config','/api/v5/account/balance','/api/v5/account/positions']);
  for(const {url,options} of f.calls){
    assert.equal(new URL(url).origin,'https://openapi.okx.com');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.body,undefined);
    if(url.endsWith('/public/time')){assert.equal(options.headers['OK-ACCESS-KEY'],undefined);continue;}
    const timestamp=options.headers['OK-ACCESS-TIMESTAMP'];assert.equal(timestamp,new Date(SERVER).toISOString());
    assert.equal(options.headers['OK-ACCESS-SIGN'],createHmac('sha256',CREDENTIALS.secretKey).update(timestamp+'GET'+new URL(url).pathname).digest('base64'));
    assert.equal(options.headers['OK-ACCESS-KEY'],CREDENTIALS.apiKey);assert.equal(options.headers['OK-ACCESS-PASSPHRASE'],CREDENTIALS.passphrase);
  }
  const files=f.vaultFiles();assert.equal(files.length,1);assert.match(files[0],/^[0-9a-f]{64}\.json$/);
  assert.equal(statSync(f.dir).mode&0o777,0o700);assert.equal(statSync(join(f.dir,'master.key')).mode&0o777,0o600);
  assert.equal(readFileSync(join(f.dir,'master.key')).length,32);assert.equal(statSync(join(f.dir,files[0])).mode&0o777,0o600);
  const disk=readFileSync(join(f.dir,files[0]),'utf8');
  for(const secret of [...Object.values(CREDENTIALS),USER,GOAL,'1234.56'])assert.ok(!disk.includes(secret));
  assert.deepEqual(Object.keys(JSON.parse(disk)).sort(),['ciphertext','iv','tag','version']);
  result.summary.tradingEquityUsd=0;f.calls.length=0;
  const reopened=f.make({fetchImpl:()=>{throw Error('status must not fetch');}});
  assert.equal((await f.handle(reopened,{action:'status'})).summary.tradingEquityUsd,1234.56);assert.equal(f.calls.length,0);
});

test('regional sites are fixed and arbitrary host/path/method inputs fail before network access',async t=>{
  const f=fixture(t);
  for(const [site,origin] of [['eea','https://eea.okx.com'],['us','https://us.okx.com']]){
    f.calls.length=0;await f.connect(f.make(),{site});assert.ok(f.calls.every(call=>new URL(call.url).origin===origin));
  }
  f.calls.length=0;
  for(const extra of [{site:'https://evil.example'},{url:'https://evil.example'},{method:'POST'},{path:'/api/v5/trade/order'},{site:'__proto__'}]){
    await safeError(f.connect(f.make(),extra),'invalid_request');
  }
  for(const input of [{action:'transfer'},{action:'status',credentials:CREDENTIALS},{action:'refresh',site:'global'}])await safeError(f.handle(f.make(),input),'invalid_request');
  assert.equal(f.calls.length,0);
});

test('missing/ambiguous/trading/withdrawal permissions stop before balances and never persist a connection',async t=>{
  for(const perm of [undefined,'','read_only,trade','read_only,withdraw','trade','Read','read_only ','read_only,read_only']){
    const f=fixture(t,{perm}),connection=f.make();await safeError(f.connect(connection),'permission_denied');
    assert.equal(f.calls.length,2);assert.deepEqual(f.vaultFiles(),[]);
    assert.deepEqual(await f.handle(connection,{action:'status'}),{provider:'okx',state:'disconnected'});
  }
});

test('credential validation rejects header injection and unknown fields without network or credential writes',async t=>{
  const f=fixture(t),connection=f.make();
  for(const credentials of [{...CREDENTIALS,apiKey:''},{...CREDENTIALS,secretKey:'a\r\nb'}, {...CREDENTIALS,passphrase:'has space'},
    {...CREDENTIALS,apiKey:'x'.repeat(257)},{...CREDENTIALS,extra:'bad'},null])await safeError(f.connect(connection,{credentials}),'invalid_credentials');
  assert.equal(f.calls.length,0);assert.deepEqual(readdirSync(f.dir),[]);
  await safeError(connection.handle({userId:'../other',goalId:GOAL,input:{action:'status'}}),'invalid_request');
  await safeError(connection.handle(null),'invalid_request');
});

test('failed replacement and failed refresh preserve the last valid encrypted connection without advancing its sync time',async t=>{
  const f=fixture(t),connection=f.make();const original=await f.connect(connection),file=join(f.dir,f.vaultFiles()[0]),disk=readFileSync(file);
  f.state.now+=60_000;f.state.perm='read_only,trade';
  await safeError(f.connect(connection,{credentials:{...CREDENTIALS,apiKey:'synthetic-new-key'}}),'permission_denied');
  assert.deepEqual(readFileSync(file),disk);assert.deepEqual(await f.handle(connection,{action:'status'}),original);
  await safeError(f.handle(connection,{action:'refresh'}),'permission_denied');assert.deepEqual(readFileSync(file),disk);
  f.state.perm='read_only';f.state.equity='99.25';
  const refreshed=await f.handle(f.make(),{action:'refresh'});assert.equal(refreshed.summary.tradingEquityUsd,99.25);
  assert.equal(refreshed.lastSyncedAt,new Date(f.state.now).toISOString());assert.notEqual(refreshed.lastSyncedAt,original.lastSyncedAt);
});

test('disconnect deletes only the selected goal’s credential file and remains disconnected after reopening',async t=>{
  const f=fixture(t),connection=f.make();await f.connect(connection);
  await connection.handle({userId:USER,goalId:'g_other',input:{action:'connect',site:'global',credentials:{...CREDENTIALS,apiKey:'synthetic-other-key'}}});
  assert.equal(f.vaultFiles().length,2);
  assert.deepEqual(await f.handle(connection,{action:'disconnect'}),{provider:'okx',state:'disconnected'});assert.equal(f.vaultFiles().length,1);
  assert.deepEqual(await f.handle(f.make(),{action:'status'}),{provider:'okx',state:'disconnected'});
  await safeError(f.handle(f.make(),{action:'refresh'}),'not_connected');
  assert.equal((await connection.handle({userId:USER,goalId:'g_other',input:{action:'status'}})).state,'connected');
});

test('wrong user/goal cannot read a connection, and ciphertext transplant or tampering fails authentication',async t=>{
  const f=fixture(t),connection=f.make();await f.connect(connection);const first=f.vaultFiles()[0];
  assert.deepEqual(await connection.handle({userId:'u_other',goalId:GOAL,input:{action:'status'}}),{provider:'okx',state:'disconnected'});
  await connection.handle({userId:'u_other',goalId:GOAL,input:{action:'connect',site:'global',credentials:CREDENTIALS}});
  const other=f.vaultFiles().find(name=>name!==first);copyFileSync(join(f.dir,first),join(f.dir,other));
  await safeError(connection.handle({userId:'u_other',goalId:GOAL,input:{action:'status'}}),'vault_unavailable');
  const envelope=JSON.parse(readFileSync(join(f.dir,first),'utf8'));const sealed=Buffer.from(envelope.ciphertext,'base64');sealed[0]^=1;envelope.ciphertext=sealed.toString('base64');
  writeFileSync(join(f.dir,first),JSON.stringify(envelope));await safeError(f.handle(connection,{action:'status'}),'vault_unavailable');
});

test('insecure permissions, symlinked records, and a lost master key are refused without silently rekeying',async t=>{
  const f=fixture(t),connection=f.make();await f.connect(connection);const file=join(f.dir,f.vaultFiles()[0]),master=join(f.dir,'master.key');
  chmodSync(file,0o644);await safeError(f.handle(connection,{action:'status'}),'vault_unavailable');chmodSync(file,0o600);
  const saved=readFileSync(file);unlinkSync(file);symlinkSync(master,file);await safeError(f.handle(connection,{action:'status'}),'vault_unavailable');
  unlinkSync(file);writeFileSync(file,saved,{mode:0o600});unlinkSync(master);
  await safeError(f.handle(connection,{action:'status'}),'vault_unavailable');
  await safeError(f.connect(connection),'vault_unavailable');assert.ok(!readdirSync(f.dir).includes('master.key'));assert.deepEqual(readFileSync(file),saved);
});

test('a stale async pairing/goal authorization after network reads prevents saving and preserves the existing connection',async t=>{
  const f=fixture(t),connection=f.make();const original=await f.connect(connection),file=join(f.dir,f.vaultFiles()[0]),disk=readFileSync(file);
  let valid=true;
  const replacement=f.make({fetchImpl:async(url,options)=>{const response=await f.fetchImpl(url,options);if(url.endsWith('/positions'))valid=false;return response;}});
  await safeError(f.connect(replacement,{}, {stillAuthorized:async()=>valid}),'stale_authorization');
  assert.deepEqual(readFileSync(file),disk);assert.deepEqual(await f.handle(connection,{action:'status'}),original);
  await safeError(f.handle(connection,{action:'disconnect'},{stillAuthorized:()=>false}),'stale_authorization');assert.deepEqual(readFileSync(file),disk);
});

test('same-goal operations serialize across instances while a distinct goal can progress independently',async t=>{
  const f=fixture(t);let release;const wait=new Promise(resolve=>{release=resolve;});let entered;
  const enteredPromise=new Promise(resolve=>{entered=resolve;});
  const slow=f.make({fetchImpl:async(url,options)=>{if(url.endsWith('/account/config')){entered();await wait;}return f.fetchImpl(url,options);}});
  const connecting=f.connect(slow);await enteredPromise;
  let disconnected=false;const disconnecting=f.handle(f.make(),{action:'disconnect'}).then(value=>{disconnected=true;return value;});
  const other=await f.make().handle({userId:USER,goalId:'g_independent',input:{action:'connect',site:'global',credentials:CREDENTIALS}});
  assert.equal(other.state,'connected');assert.equal(disconnected,false);release();
  assert.equal((await connecting).state,'connected');assert.equal((await disconnecting).state,'disconnected');
  assert.equal((await f.handle(f.make(),{action:'status'})).state,'disconnected');assert.equal(f.vaultFiles().length,1);
});

test('timeouts abort the actual fetch and expose only fixed safe errors',async t=>{
  const f=fixture(t);let signal;
  const connection=f.make({timeoutMs:15,fetchImpl:(_url,options)=>{signal=options.signal;return new Promise(()=>{});}});
  await safeError(f.connect(connection),'timeout');assert.equal(signal.aborted,true);assert.deepEqual(f.vaultFiles(),[]);
  await safeError(f.connect(f.make({fetchImpl:()=>{throw Error('remote-secret:'+CREDENTIALS.secretKey);}})),'network_error');
});

test('the deadline also bounds a stalled response body and cancels its reader',async t=>{
  const f=fixture(t);let cancelled=false;
  const body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"code":"0",'));},cancel(){cancelled=true;}});
  const connection=f.make({timeoutMs:15,fetchImpl:async()=>new Response(body)});
  await safeError(f.connect(connection),'timeout');assert.equal(cancelled,true);assert.deepEqual(f.vaultFiles(),[]);
});

test('redirects, oversized declared/streamed bodies, malformed JSON and remote errors never leak response data',async t=>{
  const f=fixture(t);
  for(const response of [new Response('remote-secret',{status:302,headers:{location:'https://evil.example'}}),
    new Response('remote-secret',{headers:{'Content-Length':'999999'}}),new Response('x'.repeat(1025)),
    new Response('remote-secret'),new Response(JSON.stringify({code:'50111',msg:'remote-secret:'+CREDENTIALS.apiKey,data:[]}))]){
    const connection=f.make({maxBytes:1024,fetchImpl:async()=>response});
    await assert.rejects(f.connect(connection),error=>{assert.ok(error instanceof OkxConnectionError);assert.doesNotMatch(error.message,/remote-secret|synthetic/);return true;});
  }
  assert.deepEqual(f.vaultFiles(),[]);
});

test('unknown balance/position values fail closed rather than claiming a successful zero-valued sync',async t=>{
  for(const overrides of [{equity:''},{equity:'Infinity'},{details:[{ccy:'BTC'},{ccy:'BTC'}]},{positions:[{pos:''}]},{positions:[{}]}]){
    const f=fixture(t,overrides);await safeError(f.connect(f.make()),'invalid_response');assert.deepEqual(f.vaultFiles(),[]);
  }
  const f=fixture(t,{equity:'0',details:[],positions:[]});
  assert.deepEqual((await f.connect(f.make())).summary,{tradingEquityUsd:0,assetCount:0,positionCount:0});
});
