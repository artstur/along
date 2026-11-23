import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {randomBytes,X509Certificate} from 'node:crypto';
import {copyFileSync,existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import {join} from 'node:path';
import {checkServerIdentity} from 'node:tls';
import {fileURLToPath} from 'node:url';
import {makeTestCa,rotateLeaf} from './cloud-ca-fixture.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const IP='54.12.34.56'; // SAN/verification fixture only. All connections go to local Docker.
const USERS=['u_aaaa1111','u_bbbb2222'];

function capture(command,args,options={}) {
  return spawnSync(command,args,{cwd:ROOT,encoding:'utf8',timeout:150_000,...options});
}
function assertOK(result,label) {
  assert.equal(result.status,0,`${label}\n${result.error??''}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
function request({port,tls=true,ca,host=IP,path,token,body,headers={}}) {
  const raw=body&&JSON.stringify(body);
  return new Promise((resolve,reject)=>{
    const req=(tls?https:http).request({
      host:'127.0.0.1',port,agent:false,path,method:body?'POST':'GET',
      ...(tls?{ca,checkServerIdentity:(_,certificate)=>checkServerIdentity(host,certificate)}:{}),
      headers:{host,...headers,...(raw?{'content-type':'application/json','content-length':Buffer.byteLength(raw)}:{}),
        ...(token?{authorization:`Bearer ${token}`}:{})},
    },res=>{
      const fingerprint=res.socket.getPeerCertificate?.()?.fingerprint256;
      let text='';
      res.on('data',chunk=>{text+=chunk;});
      res.on('end',()=>resolve({status:res.statusCode,text,fingerprint}));
    });
    req.setTimeout(4000,()=>req.destroy(Error('request timeout')));
    req.on('error',reject);
    req.end(raw);
  });
}

test('public IPv4 Compose ingress validates the IP SAN, renews and rolls back without losing pairings',
  {skip:process.env.ALONG_PUBLIC_IP_INTEGRATION!=='1',timeout:300_000},async t=>{
    const project=`along-public-ip-test-${process.pid}-${randomBytes(4).toString('hex')}`;
    const base=join(ROOT,'.tier2-integration',project);
    const edge=join(base,'edge'), host=join(base,'host'), bin=join(base,'bin');
    const lineage=join(edge,'acme/config/live/along-public-ip');
    const environment={...process.env,ALONG_EDGE_DIR:edge,ALONG_PUBLIC_IPV4:IP,ALONG_ACME_EMAIL:'along@example.invalid'};
    const overlay=join(base,'compose.fixture.yml');
    environment.COMPOSE_FILE=[
      'deploy/docker-compose.yml','deploy/docker-compose.tier2.yml','deploy/docker-compose.public-ip.yml',overlay,
    ].join(':');
    environment.COMPOSE_PROFILES='tier2';
    environment.COMPOSE_PROJECT_NAME=project;
    const compose=(args)=>capture('docker',['compose',...args],{env:environment});
    const command=(args,label)=>assertOK(compose(args),label??args.join(' '));
    const realDocker=execFileSync('which',['docker'],{encoding:'utf8'}).trim();
    const caDir=join(base,'ca'), caFile=join(caDir,'ca.crt');
    const runner=join(base,'runner-token'), bridge=join(base,'bridge-token'), model=join(base,'model-credentials');
    const marker=join(base,'reload-fault');
    environment.ALONG_EDGE_CA_FILE=caFile;

    for (const dir of [join(edge,'webroot/.well-known/acme-challenge'),join(edge,'tls/config'),join(edge,'tls/releases'),host,bin,lineage,join(base,'dsh'),join(base,'agent-state')]) {
      mkdirSync(dir,{recursive:true});
    }
    writeFileSync(join(edge,'tls/config/active.conf'),'');
    let verifiedStack=false;
    t.after(()=>{
      if (!verifiedStack) {
        const result=compose(['logs','--tail','50','edge']);
        t.diagnostic(result.stdout+result.stderr);
      }
      compose(['--profile','tier2','--profile','acme','down','-v']);
      capture(realDocker,['image','rm',`${project}:host`,`${project}:superagent`]);
      rmSync(base,{recursive:true,force:true});
    });
    const first=makeTestCa(caDir,IP);
    const second=rotateLeaf(caDir,IP,'2');
    const third=rotateLeaf(caDir,IP,'3');
    const bad=rotateLeaf(caDir,'wrong.example.test','bad-san');
    const ca=readFileSync(caFile);
    const deployLeaf=(dir)=>{
      copyFileSync(join(dir,'leaf.crt'),join(lineage,'fullchain.pem'));
      copyFileSync(join(dir,'leaf.key'),join(lineage,'privkey.pem'));
      return new X509Certificate(readFileSync(join(dir,'leaf.crt'))).fingerprint256;
    };
    const fp1=deployLeaf(first);
    writeFileSync(join(edge,'webroot/.well-known/acme-challenge/probe'),'along-ip-http01');
    writeFileSync(join(host,'users.json'),JSON.stringify(USERS.map(userId=>({userId}))),{mode:0o600});
    for (const file of [runner,bridge]) writeFileSync(file,randomBytes(32).toString('hex'),{mode:0o600});
    writeFileSync(model,'sk-synthetic-public-ip-test',{mode:0o600});
    writeFileSync(overlay,`services:
  host:
    container_name: ${project}-host
    image: ${project}:host
    build:
      tags: !override ["${project}:host"]
    volumes: ["${host}:/data"]
    secrets: !override [runner-token, bridge-token]
  netns:
    container_name: ${project}-netns
  superagent:
    container_name: ${project}-superagent
    image: ${project}:superagent
    volumes: !override ["${join(base,'dsh')}:/var/lib/dsh", "${join(base,'agent-state')}:/var/lib/along-superagent"]
  edge:
    ports: !override ["127.0.0.1::80", "127.0.0.1::443"]
secrets:
  runner-token: {file: "${runner}"}
  bridge-token: {file: "${bridge}"}
  model-credentials: {file: "${model}"}
`);

    // A fake ACME client uses synthetic certs and records command wiring. nginx, Compose
    // and Host are real. The docker shim rejects exactly one reload, then delegates rollback.
    writeFileSync(join(bin,'certbot'),`#!/bin/sh
printf '%s\\n' "$@" > "$ALONG_FIXTURE_DIR/last-certbot"
test "${'$'}{ALONG_FIXTURE_ACME_FAIL:-0}" = 0
`,{mode:0o700});
    writeFileSync(join(bin,'docker'),`#!/bin/sh
if [ "$1 $2 $3 $4 $5 $6" = "compose run --rm --no-deps -T acme" ]; then
  shift 6
  exec "$ALONG_FIXTURE_DIR/bin/certbot" "$@"
fi
if [ "$*" = "compose exec -T edge nginx -s reload" ] && [ -f "$ALONG_FIXTURE_DIR/reload-fault" ]; then
  rm "$ALONG_FIXTURE_DIR/reload-fault"
  echo 'fixture: nginx reload rejected' >&2
  exit 1
fi
exec "$ALONG_FIXTURE_DOCKER" "$@"
`,{mode:0o700});

    const config=JSON.parse(command(['--profile','tier2','--profile','acme','config','--format','json']));
    assert.deepEqual(config.services.acme.volumes.map(volume=>volume.source).sort(),[join(edge,'acme'),join(edge,'webroot')]);
    assert.deepEqual(Object.keys(config.services.acme.networks),['along-acme']);
    const certbotVersion=command(['run','--rm','--no-deps','-T','acme','--version']);
    assert.match(certbotVersion,/certbot 5\.10\.0/);
    assert.equal(config.services.host.ports,undefined);
    assert.equal(config.services.netns.ports,undefined);
    assert.deepEqual(config.services.edge.ports.map(port=>port.target).sort((a,b)=>a-b),[80,443]);
    command(['up','-d','--build','edge','host','superagent']);
    const port=(target)=>Number(command(['port','edge',String(target)]).trim().split(':').pop());
    const tlsPort=port(443);
    const httpPort=port(80);
    const certEnv={...environment,ALONG_EDGE_PROBE:`127.0.0.1:${tlsPort}`,ALONG_FIXTURE_DIR:base,
      ALONG_FIXTURE_DOCKER:realDocker,PATH:`${bin}:${process.env.PATH}`};
    const cert=(action,extra={})=>capture('python3',['deploy/public-ip-certificate.py',action],{
      env:{...certEnv,...extra},timeout:90_000,
    });
    const fetchEdge=(options)=>request({port:tlsPort,ca,...options});

    assert.equal((await request({port:httpPort,tls:false,path:'/.well-known/acme-challenge/probe'})).text,'along-ip-http01');
    assert.equal((await request({port:httpPort,tls:false,path:'/pair',body:{code:'fixture'}})).status,404);
    assert.equal((await request({port:httpPort,tls:false,path:'/.well-known/acme-challenge/missing'})).status,404);
    assertOK(cert('bootstrap'),'HTTP-01 bootstrap and first nginx reload');
    const args=readFileSync(join(base,'last-certbot'),'utf8').split('\n');
    for (const expected of ['--config-dir','/var/along-acme/config','certonly','--webroot','--webroot-path',
      '/var/www/along-acme','--required-profile','shortlived','--ip-address',IP]) assert.ok(args.includes(expected),expected);
    assert.equal((await fetchEdge({path:'/health'})).fingerprint,fp1);
    await assert.rejects(fetchEdge({path:'/health',host:'54.12.34.57'}),{code:'ERR_TLS_CERT_ALTNAME_INVALID'});

    const stackEnvironment={...environment,ALONG_EDGE_PROBE:certEnv.ALONG_EDGE_PROBE,
      ALONG_TIER2_COMPOSE_FILES:environment.COMPOSE_FILE.replaceAll(':',' '),ALONG_TIER2_COMPOSE_PROJECT:project};
    assertOK(capture('sh',['deploy/tier2-stack.sh','verify'],{env:stackEnvironment}),'public IP Tier 2 health check');

    const tokens=[];
    for (const userId of USERS) {
      const code=command(['exec','-T','host','node','host/pair-code.mjs',userId]).trim().split(/\s+/).pop();
      const paired=await fetchEdge({path:'/pair',body:{code},headers:{'x-along-client-ip':'198.51.100.19'}});
      assert.equal(paired.status,200,paired.text);
      tokens.push(JSON.parse(paired.text).token);
    }
    const hostLog=command(['logs','host']);
    assert.match(hostLog,/配对成功.*来源=\d+\.\d+\.\d+\.\d+/);
    assert.doesNotMatch(hostLog,/来源=198\.51\.100\.19/);

    async function verifyOriginalPairings(fingerprint, stage) {
      for (const token of tokens) {
        const deadline=Date.now()+5000;
        let verified;
        while (!verified) {
          try {
            verified=await fetchEdge({path:'/connection/verify',token,body:{}});
          } catch (error) {
            // A graceful reload can reset a newly opened connection. Start a
            // fresh connection and still require the exact expected leaf.
            if (error.code!=='ECONNRESET'||Date.now()>=deadline) throw Error(stage,{cause:error});
            await new Promise(resolve=>setTimeout(resolve,500));
          }
        }
        assert.equal(verified.status,200,`${stage}: ${verified.text}`);
        assert.equal(JSON.parse(verified.text).paired,true,stage);
        assert.equal(verified.fingerprint,fingerprint,stage);
      }
    }
    await verifyOriginalPairings(fp1,'first activation');
    t.diagnostic('HTTP-01 bootstrap, IP SAN and first leaf verified; both users paired');

    const fp2=deployLeaf(second);
    assert.notEqual(fp2,fp1);
    assertOK(cert('renew'),'second leaf installed through actual nginx reload');
    await verifyOriginalPairings(fp2,'successful renewal');
    const live=join(edge,'tls/config/active.conf');
    const previous=readFileSync(live,'utf8');
    t.diagnostic('second leaf served for both original pairs');

    const stackAnchor=()=>command(['ps','-q','netns']).trim();
    const oldAnchor=stackAnchor();
    assertOK(capture('sh',['deploy/tier2-stack.sh','rebuild-anchor'],{env:stackEnvironment}),'public IP Tier 2 anchor replacement');
    assert.notEqual(stackAnchor(),oldAnchor);
    await verifyOriginalPairings(fp2,'anchor rebuild');
    const deadline=Date.now()+60_000;
    for (const [index,token] of tokens.entries()) {
      let result;
      do {
        result=await fetchEdge({path:'/connection/status',token,body:{}});
        if (result.status===200) break;
        await new Promise(resolve=>setTimeout(resolve,500));
      } while (Date.now()<deadline);
      assert.equal(result.status,200,result.text);
      assert.equal(JSON.parse(result.text).userId,USERS[index]);
      const sync=await fetchEdge({path:'/sync',token,body:{after_seq:0,conversation_version:1}});
      assert.equal(sync.status,200,sync.text);
    }
    t.diagnostic('Tier 2 anchor replaced; both original pairs reached DSH readiness and /sync');


    deployLeaf(third);
    const renewalFailure=cert('renew',{ALONG_FIXTURE_ACME_FAIL:'1'});
    assert.equal(renewalFailure.status,1);
    assert.match(renewalFailure.stderr,/ALONG TLS ALERT/);
    assert.equal(readFileSync(live,'utf8'),previous);
    await verifyOriginalPairings(fp2,'failed renewal');

    deployLeaf(bad);
    t.diagnostic('ACME failure retained the verified leaf and emitted an alert');
    const wrongSAN=cert('renew');
    assert.equal(wrongSAN.status,1);
    assert.match(wrongSAN.stderr,/ALONG TLS ALERT/);
    assert.equal(readFileSync(live,'utf8'),previous);
    await verifyOriginalPairings(fp2,'rejected certificate');

    t.diagnostic('the invalid IP SAN was rejected; the original pairs stayed authorized');
    const fp3=deployLeaf(third);
    writeFileSync(marker,'once');
    const reloadFailure=cert('renew');
    assert.equal(reloadFailure.status,1);
    assert.match(reloadFailure.stderr,/fixture: nginx reload rejected/);
    assert.match(reloadFailure.stderr,/ALONG TLS ALERT/);
    assert.doesNotMatch(reloadFailure.stderr,/rollback reload\/probe failed/);
    assert.equal(readFileSync(live,'utf8'),previous);
    assert.equal(existsSync(marker),false);
    await verifyOriginalPairings(fp2,'reload rollback');

    t.diagnostic('rejected reload restored the previous certificate and emitted an alert');
    assertOK(cert('renew'),'reconcile issued but previously unapplied certificate');
    await verifyOriginalPairings(fp3,'reconcile after failure');
    t.diagnostic('retry activated the issued cert and both original pairs stayed authorized');
    verifiedStack=true;
  });
