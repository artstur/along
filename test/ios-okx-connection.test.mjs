import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Run the actual native decoder on Foundation's JSON types. No iOS account,
// pairing, UI automation, network calls or credentials are involved.
test('native OKX summaries accept valid JSON and reject malformed connected states', {skip: process.platform !== 'darwin'}, () => {
  const source = readFileSync(new URL('../ios/AlongHealth/Sources/OkxConnection.swift', import.meta.url), 'utf8');
  const start = source.indexOf('private struct OKXConnectionSnapshot {');
  assert.notEqual(start, -1, 'native summary decoder must be available');
  const temporary = mkdtempSync(join(tmpdir(), 'along-okx-native-test-'));
  try {
    const harness = join(temporary, 'main.swift');
    const executable = join(temporary, 'decoder-test');
    writeFileSync(harness, 'import Foundation\nimport CoreFoundation\n' + source.slice(start) + String.raw`

func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fatalError(message) }
}
func json(_ text: String) -> [String: Any] {
    try! JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
}
func connected(_ summary: String, timestamp: String = "2026-11-17T13:12:34.123Z") -> [String: Any] {
    var value = json(#"{"provider":"okx","state":"connected"}"#)
    value["lastSyncedAt"] = timestamp
    value["summary"] = json(summary)
    return value
}
let valid = connected(#"{"tradingEquityUsd":"1234.56","assetCount":2,"positionCount":1}"#)
private let decoded = OKXConnectionSnapshot(valid)
check(decoded?.connected == true, "real connected snapshot should decode")
check(decoded?.lastSyncedAt != nil, "fractional ISO timestamp should decode")
check(decoded?.summary?.assetCount == 2, "asset count should be retained")
check(decoded?.summary?.positionCount == 1, "position count should be retained")
for equity in ["0", "1", "-1.5", "1e3"] {
    check(OKXConnectionSnapshot(connected("{\"tradingEquityUsd\":\(equity),\"assetCount\":0,\"positionCount\":0}")) != nil, "valid numeric equity should decode, including zero and one")
}
check(OKXConnectionSnapshot(connected(#"{"tradingEquityUsd":"0.01","assetCount":1,"positionCount":0}"#, timestamp: "2026-11-17T13:12:34Z")) != nil, "ISO timestamp without fraction should decode")
for bad in [
    #"{"tradingEquityUsd":true,"assetCount":1,"positionCount":0}"#,
    #"{"tradingEquityUsd":"1garbage","assetCount":1,"positionCount":0}"#,
    #"{"tradingEquityUsd":"NaN","assetCount":1,"positionCount":0}"#,
    #"{"tradingEquityUsd":"Infinity","assetCount":1,"positionCount":0}"#,
    #"{"tradingEquityUsd":"1","assetCount":true,"positionCount":0}"#,
    #"{"tradingEquityUsd":"1","assetCount":-1,"positionCount":0}"#,
    #"{"tradingEquityUsd":"1","assetCount":1.5,"positionCount":0}"#,
    #"{"tradingEquityUsd":"1","assetCount":9223372036854775808,"positionCount":0}"#,
    #"{"tradingEquityUsd":"1","assetCount":1}"#
] {
    check(OKXConnectionSnapshot(connected(bad)) == nil, "malformed or ambiguous summary must not become connected")
}
var missingDate = valid
missingDate.removeValue(forKey: "lastSyncedAt")
check(OKXConnectionSnapshot(missingDate) == nil, "connected requires actual sync timestamp")
check(OKXConnectionSnapshot(connected(#"{"tradingEquityUsd":"1","assetCount":1,"positionCount":0}"#, timestamp: "yesterday")) == nil, "invalid timestamp must fail closed")
check(OKXConnectionSnapshot(json(#"{"provider":"okx","state":"pending"}"#)) == nil, "unknown status must not be connected")
check(OKXConnectionSnapshot(json(#"{"provider":"health","state":"disconnected"}"#)) == nil, "wrong provider must be rejected")
private let disconnected = OKXConnectionSnapshot(json(#"{"provider":"okx","state":"disconnected"}"#))
check(disconnected?.connected == false && disconnected?.summary == nil, "disconnected must not retain stale summary")
print("native OKX decoder passed")
`);
    execFileSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(temporary, 'module-cache'), harness, '-o', executable], {timeout: 60000, maxBuffer: 2_000_000});
    const output = execFileSync(executable, {encoding: 'utf8', timeout: 10000});
    assert.match(output, /native OKX decoder passed/);
  } finally {
    rmSync(temporary, {recursive: true, force: true});
  }
});
