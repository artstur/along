import {connect} from 'node:http2';
import {createHash, createPrivateKey, sign} from 'node:crypto';
import {readFileSync, statSync} from 'node:fs';

const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const topic='com.artstur.AlongHealth';

export function createApnsProvider(env=process.env,openSession=connect) {
  const {ALONG_APNS_KEY_FILE:file,ALONG_APNS_TEAM_ID:team,ALONG_APNS_KEY_ID:kid}=env;
  if (!file&&!team&&!kid) return null;
  try {
    if (!/^[A-Z0-9]{10}$/.test(team)||!/^[A-Z0-9]{10}$/.test(kid)||!file||(statSync(file).mode&0o077)) throw Error();
    const key=createPrivateKey(readFileSync(file));
    if (key.asymmetricKeyDetails?.namedCurve!=='prime256v1') throw Error();
    let bearer='',signedAt=0;
    function credential() {
      const now=Math.floor(Date.now()/1000);
      if (!bearer||now<signedAt||now-signedAt>=3000) {
        const unsigned=encode({alg:'ES256',kid})+'.'+encode({iss:team,iat:now});
        bearer=unsigned+'.'+sign('sha256',Buffer.from(unsigned),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
        signedAt=now;
      }
      return bearer;
    }
    const sessions=new Map();
    function session(environment) {
      let client=sessions.get(environment);
      if (client&&!client.closed&&!client.destroyed) return client;
      const authority=environment==='production'?'https://api.push.apple.com':'https://api.sandbox.push.apple.com';
      client=openSession(authority);
      sessions.set(environment,client);
      client.on('error',()=>client.destroy());
      client.on('goaway',()=>client.close());
      client.on('close',()=>{if (sessions.get(environment)===client) sessions.delete(environment);});
      client.unref();
      return client;
    }
    return async ({environment,token},along,expiresAt)=>{
      const collapse=createHash('sha256').update(JSON.stringify([along.userId,along.eventId])).digest('hex');
      const title={recommendation_ready:'Along 有一条新推荐',task_result:'Along 任务有了结果',reminder_due:'Along 任务提醒'}[along.kind];
      const payload=JSON.stringify({aps:{alert:{title,body:'打开查看详情'},sound:'default'},along});
      return await new Promise((resolve,reject)=>{
        const stream=session(environment).request({':method':'POST',':path':'/3/device/'+token,
          authorization:'bearer '+credential(),'apns-push-type':'alert','apns-priority':'10','apns-topic':topic,
          'apns-collapse-id':collapse,'apns-expiration':String(Math.floor(expiresAt/1000))});
        let status=0,data='';
        const timer=setTimeout(()=>{stream.destroy();reject(Error('APNs 请求超时'));},12000);
        stream.setEncoding('utf8');
        stream.on('response',headers=>{status=headers[':status'];});
        stream.on('data',chunk=>{if (data.length<2048) data+=chunk;});
        stream.on('close',()=>{clearTimeout(timer);if (!stream.readableEnded) reject(Error('APNs 连接关闭'));});
        stream.on('error',()=>reject(Error('APNs 连接失败')));
        stream.on('end',()=>{
          clearTimeout(timer);
          let reason='';
          try {reason=JSON.parse(data).reason;} catch { /* Successful APNs responses have no body. */ }
          if (status===200) resolve('accepted');
          else if (status===410||['BadDeviceToken','DeviceTokenNotForTopic'].includes(reason)) resolve('invalid_device');
          else reject(Error('APNs 尚未接受请求'));
        });
        stream.end(payload);
      });
    };
  } catch {
    console.warn('Along 远程通知签名配置不可用');
    return null;
  }
}
