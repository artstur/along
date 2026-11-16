import test from 'node:test';
import assert from 'node:assert/strict';
import {publicSourceURL,safeRecommendation,recommendationCard} from '../web/recommendations.mjs';
import {recommendation} from './recommendation-fixture.mjs';

test('only public credential-free HTTPS source links can be rendered',()=>{
  for(const url of ['javascript:alert(1)','http://www.gz.gov.cn','https://localhost/path','https://127.0.0.1','https://[::1]',
    'https://2130706433','https://private.internal','https://a.local','https://a.test','https://a.example','https://user:pass@www.gz.gov.cn',
    'https://www.gz.gov.cn:4176','https://www.gz.gov.cn/?access_token=secret','https://www.gz.gov.cn/\\evil','https://www.gz.gov.cn/\n']) assert.equal(publicSourceURL(url),null,url);
  assert.equal(publicSourceURL('https://www.gz.gov.cn:443/route?id=42'),'https://www.gz.gov.cn/route?id=42');
});
test('unknown/malformed optional recommendation extensions fail closed without throwing',()=>{
  for(const bad of [null,[],{},'text',{...recommendation(),version:2},{...recommendation(),sources:[]},
    {...recommendation(),sources:[recommendation().sources[0],recommendation().sources[0]]},
    {...recommendation(),options:[{...recommendation().options[0],facts:[{label:'距离',value:'12km',sourceIds:[]}]}]}]) assert.equal(safeRecommendation(bad),null);
  const r=recommendation();r.options[0].checks[0].sourceIds=['not_retrieved'];assert.equal(safeRecommendation(r),null);
});
test('risk, incomplete checks and expired sources cannot appear as current recommended outings',()=>{
  const r=recommendation();r.options[0].checks[0].status='risk';r.options[0].checks[0].summary='官方临时关闭';
  assert.equal(safeRecommendation(r).options[0].status,'excluded');assert.equal(safeRecommendation(r).status,'partial');
  const html=recommendationCard(r,{now:Date.parse('2099-01-01T01:00:00Z')});assert.match(html,/暂不建议/);assert.match(html,/官方临时关闭/);
  r.options[0].checks[0].status='ok';r.options[0].checks[1].status='risk';assert.equal(safeRecommendation(r).options[0].status,'excluded');
  r.options[0].checks=[];assert.equal(safeRecommendation(r).options[0].status,'conditional');
  assert.match(recommendationCard(recommendation(),{now:Date.parse('2099-01-03T00:00:00Z')}),/资料已过期/);
  assert.doesNotMatch(recommendationCard(recommendation(),{now:Date.parse('2099-01-03T00:00:00Z')}),/>适合考虑</);
});
test('cards expose comparable evidence and unknowns while escaping every external text field',()=>{
  const r=recommendation();r.options[0].title='<img src=x onerror=alert(1)>';r.summary='<script>alert(1)</script>';
  const html=recommendationCard(r,{eventId:'reply_one',now:Date.parse('2099-01-01T01:00:00Z')});
  assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<script>|<img/);
  assert.match(html,/尚待确认/);assert.match(html,/爬升尚未核实/);assert.match(html,/依据来源/);assert.match(html,/检索/);
  assert.match(html,/href="https:\/\/www.gz.gov.cn\/route" target="_blank" rel="noopener noreferrer"/);
  assert.match(html,/data-event-id="reply_one"/);assert.doesNotMatch(html,/采用|tool|Worker/);
});
