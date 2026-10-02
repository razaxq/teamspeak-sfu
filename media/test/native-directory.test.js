import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClientDirectory } from '../src/native/client-directory.js';
const row = 'clid=3 cid=1 client_type=0 client_unique_identifier=uid client_servergroups=6 client_lastconnected=100';
test('directory binds connection generations and revokes disconnect, move and identity changes', () => {
  const revoked=[];
  const directory=createClientDirectory({serverId:'server',revokeClient:id=>revoked.push(id)});
  directory.snapshot(row+'\nerror id=0 msg=ok\n');
  const first=directory.get('3');assert.ok(first.canPublish);
  directory.snapshot(row);assert.equal(directory.get('3').sessionId,first.sessionId);
  directory.notification('notifyclientleftview clid=3 reasonid=8');assert.equal(directory.get('3'),undefined);
  directory.snapshot(row);assert.notEqual(directory.get('3').sessionId,first.sessionId);
  directory.notification('notifyclientmoved clid=3 ctid=2');assert.equal(directory.get('3'),undefined);
  directory.snapshot(row);directory.snapshot(row.replace('client_unique_identifier=uid','client_unique_identifier=new-uid'));
  assert.equal(directory.get('3').canPublish,true);assert.equal(revoked.length,3);
  directory.invalidate();assert.equal(directory.size,0);assert.equal(revoked.length,4);
});
test('malformed snapshots fail closed and notification epochs guard stale snapshots', () => {
  const directory=createClientDirectory({serverId:'server',revokeClient:()=>{}});
  directory.snapshot(row);const version=directory.version;
  directory.notification('notifyclientleftview clid=3 reasonid=8');assert.notEqual(directory.version,version);
  assert.throws(()=>directory.snapshot(row.replace('cid=1','cid=invalid')));
  assert.equal(directory.size,0);
  directory.snapshot(row+'|clid=4 cid=1 client_type=1 client_unique_identifier=query client_servergroups=2');
  assert.equal(directory.size,1);assert.equal(directory.get('4'),undefined);
});
test('desktop-style fields and large unrelated notifications do not invalidate the directory', () => {
  const directory=createClientDirectory({serverId:'server',revokeClient:()=>{}});
  directory.snapshot(row);
  const version=directory.version;
  directory.notification('notifyserveredited unsupported_future_field='+ 'x'.repeat(70000));
  assert.equal(directory.version,version);assert.ok(directory.healthy);
  directory.notification('notifycliententerview '+row.replace('cid=1','ctid=1')+' client_base64HashClientUID=hash client_badges='+ 'x'.repeat(3000));
  assert.ok(directory.healthy);assert.ok(directory.get('3').canPublish);
  directory.notification('notifycliententerview clid=4 ctid=1 client_type=0');
  assert.ok(directory.healthy);assert.equal(directory.get('4'),undefined);
});
test('native empty fields without equals are valid notification arguments', () => {
  const directory=createClientDirectory({serverId:'server',revokeClient:()=>{}});
  directory.snapshot(row);
  directory.notification('notifycliententerview '+row.replace('cid=1','ctid=1')+' client_meta_data client_away_message client_signed_badges');
  assert.ok(directory.healthy);assert.ok(directory.get('3').canPublish);
});

test('ordinary connected users can publish without a server group requirement', () => {
  const revoked=[];
  const directory=createClientDirectory({serverId:'server',revokeClient:id=>revoked.push(id)});
  const guest=row.replace('client_servergroups=6','client_servergroups=8');
  directory.snapshot(guest);const original=directory.get('3');
  assert.equal(original.canPublish,true);
  directory.notification('notifyclientupdated clid=3 client_servergroups=9');
  directory.snapshot(guest.replace('client_servergroups=8','client_servergroups=9'));
  assert.equal(directory.get('3').sessionId,original.sessionId);
  assert.deepEqual(revoked,[]);
  directory.snapshot(guest.replace(' client_servergroups=8',''));
  assert.equal(directory.get('3').canPublish,true);
  assert.equal(directory.get('3').sessionId,original.sessionId);
  directory.snapshot(guest.replace('client_type=0','client_type=1'));
  assert.equal(directory.get('3'),undefined);
  assert.deepEqual(revoked,['3']);
});
