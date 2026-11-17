import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

test('shared device receipts advance only matching events and quarantine permanent failures',{skip:process.platform!=='darwin'},()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-device-queue-'));
  try {
    writeFileSync(join(dir,'main.swift'),`import Foundation
var state: [String:Any] = [:]
let first: [String:Any] = ["event_id":"event_one","body":["sequence":1]]
let second: [String:Any] = ["event_id":"event_two","body":["sequence":2]]
try DeviceEventQueue.append(first,to:&state)
try DeviceEventQueue.append(first,to:&state)
precondition((state["pending"] as! [[String:Any]]).count == 1)
do {try DeviceEventQueue.append(["event_id":"event_one","body":["sequence":3]],to:&state);fatalError("conflict accepted")} catch {}
try DeviceEventQueue.append(second,to:&state)
precondition(DeviceEventQueue.advance(&state,receipt:["event_id":"unrelated","status":"accepted"]) == .retry)
precondition((state["pending"] as! [[String:Any]]).count == 2)
precondition(DeviceEventQueue.advance(&state,receipt:["event_id":"event_one","status":"stale"]) == .held)
precondition((state["held"] as! [[String:Any]]).count == 1)
precondition((state["pending"] as! [[String:Any]]).first?["event_id"] as? String == "event_two")
precondition(DeviceEventQueue.advance(&state,receipt:["event_id":"event_two","status":"duplicate"]) == .acknowledged)
precondition((state["pending"] as! [[String:Any]]).isEmpty)
try DeviceEventQueue.append(first,to:&state)
precondition(DeviceEventQueue.advance(&state,receipt:["event_id":"event_one","status":"rejected"]) == .held)
do {try DeviceEventQueue.append(second,to:&state,maxPending:0);fatalError("full queue accepted")} catch {}
print("device queue verified")
`);
    execFileSync('xcrun',['swiftc','-module-cache-path',join(dir,'cache'),fileURLToPath(new URL('../ios/AlongHealth/Sources/DeviceEventQueue.swift',import.meta.url)),join(dir,'main.swift'),'-o',join(dir,'check')],{timeout:60000,maxBuffer:2_000_000});
    assert.match(execFileSync(join(dir,'check'),{encoding:'utf8',timeout:10000}),/device queue verified/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
