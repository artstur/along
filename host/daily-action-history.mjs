import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {cleanDailyDelegation} from '../web/contextual-planning.mjs';

const filename=dir=>join(dir,'current-daily-actions.json');
function today(zone,now) {
  try { return new Intl.DateTimeFormat('en-CA',{timeZone:zone}).format(now); } catch { return null; }
}
function active(dir,now) {
  let records;
  try { records=JSON.parse(readFileSync(filename(dir),'utf8')); }
  catch(error) { if (error.code==='ENOENT') return []; throw error; }
  if (!Array.isArray(records)) throw Error('每日安排记录格式无效');
  const current=records.filter(r=>r&&r.localDate===today(r.timezone,now));
  if (current.length!==records.length) write(dir,current);
  return current;
}
export function pruneDailyActions(dir) { active(dir,Date.now()); }
function write(dir,records) {
  const file=filename(dir);
  if (!records.length) {try {unlinkSync(file);} catch(error) {if (error.code!=='ENOENT') throw error;}return;}
  const temporary=file+'.'+randomUUID();
  writeFileSync(temporary,JSON.stringify(records),{mode:0o600,flag:'wx'});
  renameSync(temporary,file);
}
function identity(pair,snapshot) {
  const p=snapshot?.planning,grant=cleanDailyDelegation(p?.dailyDelegation);
  if (!grant||typeof pair!=='string'||!/^[a-f0-9]{64}$/.test(pair)||!snapshot.contextReviewAllowed||
      !Array.isArray(snapshot.selectedTypes)||!grant.topics.every(t=>snapshot.selectedTypes.includes(t))) return null;
  return createHash('sha256').update(JSON.stringify([pair,grant,p.localDate,p.timezone,
    [...snapshot.selectedTypes].sort(),snapshot.comparisonHistoryAllowed===true])).digest('hex');
}
export function rememberDailyAction(dir,pair,run,now=Date.now()) {
  const snapshot=run.input?.snapshot,p=snapshot?.planning,action=run.result?.reassessment?.dailyActions;
  if (!action||run.status!=='done'||run.actual!==true||run.runtime!=='dsh-superagent'||
      !run.ticket?.id||run.requestId!==p?.revisionId||action.localDate!==p.localDate||
      p.localDate!==today(p.timezone,now)||Date.parse(p.now)>now) return;
  const key=identity(pair,snapshot);
  if (!key) return;
  const records=active(dir,now),old=records.find(r=>r.key===key);
  if (old&&(old.requestId===run.requestId||Date.parse(old.at)>=Date.parse(p.now))) return;
  const {workoutMinutes,workoutReminderAt,sleepReminderAt,bedtimeAt}=action;
  const record={key,localDate:p.localDate,timezone:p.timezone,requestId:run.requestId,at:p.now,
    actions:{workoutMinutes,workoutReminderAt,sleepReminderAt,bedtimeAt}};
  write(dir,[...records.filter(r=>r.key!==key),record]);
}
export function includeEarlierDailyAction(dir,pair,snapshot,now=Date.now()) {
  const p=snapshot.planning,records=active(dir,now);
  const key=identity(pair,snapshot),old=key&&records.find(r=>r.key===key);
  if (!old||old.requestId===p.revisionId||Date.parse(old.at)>Date.parse(p.now)) return;
  const prior={at:old.at,decision:'daily_actions',reason:JSON.stringify(old.actions)};
  p.recentDecisions=[...(p.recentDecisions||[]).filter(d=>d.decision!=='daily_actions').slice(-5),prior];
}
