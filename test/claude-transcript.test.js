import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-claude-chat-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
const { readTranscript } = await import('../server/transcript.js');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const row = (type, text) => JSON.stringify({ message: { content: [{ type: 'text', text }] }, type, timestamp: '2026-10-31T09:00:00Z' });
const texts = file => readTranscript(file, 200).items.filter(x => ['user','text'].includes(x.k)).map(x => x.s);

test('Claude chat survives multi-MB tool images and ignored API blobs before the newest message', () => {
  const file = path.join(tmp, 'large.jsonl');
  const image = 'A'.repeat(5 * 1024 * 1024);
  const giant = { type: 'user', message: { content: [{ type: 'tool_result', content: [
    { type: 'image', source: { type: 'base64', data: image } },
    { type: 'text', text: 'Gambar diterima' },
  ] }] } };
  fs.writeFileSync(file, [row('user','Pertanyaan awal'), row('assistant','Jawaban awal'),
    JSON.stringify(giant), JSON.stringify({type:'api-request-blob',message:image}),
    row('assistant','Jawaban terbaru'),
  ].join('\n')+'\n');
  const response = readTranscript(file, 200);
  assert.deepEqual(texts(file), ['Pertanyaan awal','Jawaban awal','Jawaban terbaru']);
  assert.deepEqual(response.items.map(x=>x.k), ['user','text','result','text']);
  assert.equal(response.items[2].s, 'Gambar diterima');
  assert.ok(JSON.stringify(response).length < 1000, 'image base64 and API metadata stay out of the response');
  assert.deepEqual(readTranscript(file, 1).items.map(x=>x.s), ['Jawaban terbaru']);
});

test('assistant type after its long message, UTF-8, partial appends, truncation and replacement remain correct', () => {
  const file=path.join(tmp,'append.jsonl');
  const say=row('assistant','Halo 🚂');
  fs.writeFileSync(file, row('user','Mulai')+'\n'+say.slice(0,35));
  assert.deepEqual(texts(file), ['Mulai']);
  assert.deepEqual(texts(file), ['Mulai']);
  fs.appendFileSync(file,say.slice(35)+'\n');
  assert.deepEqual(texts(file), ['Mulai','Halo 🚂']);
  assert.deepEqual(texts(file), ['Mulai','Halo 🚂']);
  const long=row('assistant','Panjang '+ '🚂'.repeat(2000));
  assert.ok(long.indexOf('"type":"assistant"')>320);
  fs.appendFileSync(file,long+'\n');
  assert.equal(texts(file).length,3);
  fs.writeFileSync(file,row('user','Baru')+'\n');
  assert.deepEqual(texts(file),['Baru']);
  const replacement=path.join(tmp,'replacement');
  fs.writeFileSync(replacement,row('assistant','Berkas pengganti dengan inode baru')+'\n');
  fs.renameSync(replacement,file);
  assert.deepEqual(texts(file),['Berkas pengganti dengan inode baru']);
});

test('internal instructions and sidechain messages stay hidden while cached visible items stay bounded', () => {
  const file=path.join(tmp,'bounded.jsonl');
  fs.writeFileSync(file,[row('user','<system-reminder>internal</system-reminder>'),
    JSON.stringify({type:'assistant',isSidechain:true,message:{content:[{type:'text',text:'private'}]}}),
    JSON.stringify({type:'user',isMeta:true,message:{content:'internal'}}),
    ...Array.from({length:2100},(_,i)=>row('assistant','Pesan '+i)),
  ].join('\n')+'\n');
  const items=readTranscript(file,5000).items;
  assert.equal(items.length,2000);
  assert.equal(items[0].s,'Pesan 100');
  assert.equal(items.at(-1).s,'Pesan 2099');
});

test('Antigravity history also survives its former 4-MB byte cutoff and later appends', async () => {
  const { readAgyTranscript } = await import('../server/antigravity.js');
  const file = path.join(tmp,'agy.jsonl');
  fs.writeFileSync(file,[
    JSON.stringify({type:'USER_INPUT',content:'<USER_REQUEST>Pertanyaan Gemini</USER_REQUEST>'}),
    JSON.stringify({type:'PLANNER_RESPONSE',content:'Jawaban Gemini'}),
    JSON.stringify({type:'INTERNAL',content:'A'.repeat(5*1024*1024)}),
    JSON.stringify({type:'PLANNER_RESPONSE',content:'Pesan terakhir'}),
  ].join('\n')+'\n');
  assert.deepEqual(readAgyTranscript(file).items.map(x=>x.s),['Pertanyaan Gemini','Jawaban Gemini','Pesan terakhir']);
  fs.appendFileSync(file,JSON.stringify({type:'PLANNER_RESPONSE',content:'Tambahan'})+'\n');
  assert.deepEqual(readAgyTranscript(file).items.map(x=>x.s),['Pertanyaan Gemini','Jawaban Gemini','Pesan terakhir','Tambahan']);
});

test('complete final JSON without newline is shown once when later appends add the separator', () => {
  const file=path.join(tmp,'no-newline.jsonl');
  fs.writeFileSync(file,row('user','Tanpa newline'));
  assert.deepEqual(texts(file),['Tanpa newline']);
  fs.appendFileSync(file,'\n'+row('assistant','Baru'));
  assert.deepEqual(texts(file),['Tanpa newline','Baru']);
  fs.appendFileSync(file,'\n');
  assert.deepEqual(texts(file),['Tanpa newline','Baru']);
});
