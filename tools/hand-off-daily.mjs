// Publish one explicitly requested delegation on this Mac to its paired iPhone.
// Input contains only receipt IDs and approved scope; no samples or credentials.
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {registerDailyGrant} from '../host/daily-delegation.mjs';
const dir=process.env.ALONG_AGENT_STATE_DIR||join(homedir(),'.along','agent-host');
const {hash}=JSON.parse(readFileSync(join(dir,'pairing.json'),'utf8'));
const {anchor,grant}=JSON.parse(readFileSync(0,'utf8'));
registerDailyGrant(dir,hash,anchor,grant);
console.log('已提交到已配对 iPhone 的原目标，等待手机核对 DSH 工单。');
