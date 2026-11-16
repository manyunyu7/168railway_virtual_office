import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-delta-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
const { readTranscript } = await import('../server/transcript.js');
const { readRollout } = await import('../server/codex.js');
const { readAgyTranscript } = await import('../server/antigravity.js');
after(() => fs.rmSync(tmp, {recursive:true, force:true}));
const row = text => JSON.stringify({type:'assistant',timestamp:'2026-11-16T12:00:00Z',message:{content:[{type:'text',text}]}})+'\n';

for (const engine of ['claude','codex','agy']) {
  const file = path.join(tmp, engine+'.jsonl');
  const encode = text => engine === 'claude' ? row(text) : engine === 'agy'
    ? JSON.stringify({type:'MODEL_RESPONSE',content:text})+'\n'
    : JSON.stringify({type:'event_msg',payload:{type:'item_completed',item:{type:'AgentMessage',content:[{type:'text',text}]}}})+'\n';
  const read = (after, sid='one') => engine === 'claude' ? readTranscript(file,200,{sid,after}) : engine === 'agy' ? readAgyTranscript(file,200,{sid,after}) : readRollout(file,200,()=>'',{sid,after});
  test(engine+': full, tiny no-change response, append-only delta and scope reset', () => {
    fs.writeFileSync(file, encode('first'));
    const full=read(); assert.equal(full.reset,true);assert.equal(full.items.length,1);
    const same=read(full.cursor);assert.equal(same.reset,false);assert.deepEqual(same.items,[]);
    fs.appendFileSync(file,encode('second'));
    const delta=read(same.cursor);assert.equal(delta.reset,false);assert.deepEqual(delta.items.map(i=>i.s),['second']);
    assert.deepEqual(read(delta.cursor).items,[]);
    assert.equal(read(delta.cursor,'other-session').reset,true);
    assert.equal(read('invalid').reset,true);
  });
  test(engine+': truncation, regrowth and inode replacement reset old cursor', () => {
    const before=read();
    fs.writeFileSync(file,encode('new file '+ 'x'.repeat(400)));
    const changed=read(before.cursor);assert.equal(changed.reset,true);assert.equal(changed.items.length,1);
    assert.equal(read(changed.cursor).reset,false);
    fs.writeFileSync(file,encode('short'));
    const short=read(changed.cursor);assert.equal(short.reset,true);
    const other=file+'.replacement';fs.writeFileSync(other,encode('replaced'));fs.renameSync(other,file);
    assert.equal(read(short.cursor).reset,true);
  });
}

test('cursor behind retained window resets to bounded recent items', () => {
  const file=path.join(tmp,'cap.jsonl');fs.writeFileSync(file,row('start'));
  const initial=readTranscript(file,200,{sid:'cap'});
  fs.appendFileSync(file,Array.from({length:2100},(_,i)=>row('line'+i)).join(''));
  const delta=readTranscript(file,200,{sid:'cap',after:initial.cursor});
  assert.equal(delta.reset,true);assert.equal(delta.items.length,200);
  assert.equal(delta.items.at(-1).s,'line2099');
  const legacy=readTranscript(file,200);assert.deepEqual(Object.keys(legacy),['items','size']);
  assert.deepEqual(legacy.items,delta.items);
});

test('complete final record without newline is not duplicated in delta', () => {
  const file=path.join(tmp,'partial.jsonl');fs.writeFileSync(file,row('one').trimEnd());
  const a=readTranscript(file,200,{sid:'partial'});
  fs.appendFileSync(file,'\n'+row('two'));
  const b=readTranscript(file,200,{sid:'partial',after:a.cursor});
  assert.equal(b.reset,false);assert.deepEqual(b.items.map(i=>i.s),['two']);
});
