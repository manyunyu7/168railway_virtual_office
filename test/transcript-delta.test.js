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

test('first/gen/older on full and delta responses', () => {
  const file=path.join(tmp,'seq.jsonl');fs.writeFileSync(file,Array.from({length:10},(_,i)=>row('m'+i)).join(''));
  const full=readTranscript(file,4,{sid:'seq'});
  assert.equal(full.first,6);assert.equal(typeof full.gen,'string');assert.equal(full.older,true);
  assert.deepEqual(full.items.map(i=>i.s),['m6','m7','m8','m9']);
  const all=readTranscript(file,50,{sid:'seq'});assert.equal(all.first,0);assert.equal(all.older,false);assert.equal(all.gen,full.gen);
  fs.appendFileSync(file,row('m10')+row('m11'));
  const delta=readTranscript(file,4,{sid:'seq',after:full.cursor});
  assert.equal(delta.reset,false);assert.equal(delta.first,10);assert.equal(delta.older,true);assert.equal(delta.gen,full.gen);
  assert.deepEqual(delta.items.map(i=>i.s),['m10','m11']);
  const none=readTranscript(file,4,{sid:'seq',after:delta.cursor});assert.deepEqual(none.items,[]);assert.equal(none.first,12);assert.equal(none.older,true);
  assert.deepEqual(Object.keys(readTranscript(file,4)),['items','size']);
});

test('paging before= walks back to older=false; wrong gen or range resets; n clamped', () => {
  const file=path.join(tmp,'page.jsonl');fs.writeFileSync(file,Array.from({length:450},(_,i)=>row('p'+i)).join(''));
  const head=readTranscript(file,50,{sid:'page'});assert.equal(head.first,400);
  const seen=[...head.items.map(i=>i.s)];let first=head.first,older=head.older,pages=0;
  while(older){
    const pg=readTranscript(file,120,{sid:'page',before:String(first),gen:head.gen});
    assert.deepEqual(Object.keys(pg).sort(),['first','gen','items','older']);
    assert.equal(pg.first,Math.max(0,first-120));assert.equal(pg.items.length,first-pg.first);assert.equal(pg.gen,head.gen);
    seen.unshift(...pg.items.map(i=>i.s));first=pg.first;older=pg.older;pages++;
  }
  assert.equal(pages,4);assert.equal(first,0);
  assert.deepEqual(seen,Array.from({length:450},(_,i)=>'p'+i));
  assert.deepEqual(readTranscript(file,120,{sid:'page',before:'400',gen:'nope'}),{items:[],reset:true,gen:head.gen});
  assert.deepEqual(readTranscript(file,120,{sid:'page',before:'451',gen:head.gen}),{items:[],reset:true,gen:head.gen});
  assert.equal(readTranscript(file,120,{sid:'page',before:'-1',gen:head.gen}).reset,true);
  assert.equal(readTranscript(file,120,{sid:'page',before:'abc',gen:head.gen}).reset,true);
  assert.equal(readTranscript(file,120,{sid:'page',before:'400',gen:''}).reset,true);
  assert.equal(readTranscript(file,1000,{sid:'page',before:'400',gen:head.gen}).items.length,200);
  const one=readTranscript(file,-5,{sid:'page',before:'400',gen:head.gen});assert.equal(one.items.length,1);assert.equal(one.items[0].s,'p399');
  const at0=readTranscript(file,10,{sid:'page',before:'0',gen:head.gen});assert.deepEqual(at0,{items:[],first:0,gen:head.gen,older:false});
});

test('paging respects the retained window and a new generation', () => {
  const file=path.join(tmp,'evict.jsonl');fs.writeFileSync(file,Array.from({length:2300},(_,i)=>row('e'+i)).join(''));
  const head=readTranscript(file,100,{sid:'ev'});assert.equal(head.first,2200);
  const edge=readTranscript(file,200,{sid:'ev',before:'500',gen:head.gen});
  assert.equal(edge.first,300);assert.equal(edge.older,false);assert.equal(edge.items[0].s,'e300');
  assert.equal(readTranscript(file,200,{sid:'ev',before:'299',gen:head.gen}).reset,true);
  fs.writeFileSync(file,row('fresh'));
  const after=readTranscript(file,200,{sid:'ev',before:'2200',gen:head.gen});
  assert.equal(after.reset,true);assert.notEqual(after.gen,head.gen);
});
