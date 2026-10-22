import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-sysmon-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ token: 'x', roots: [tmp] }));
const S = await import('../server/sysmon.js');

test('vm_stat + sysctl', () => {
  const v = S.parseVmStat(`Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                4143.
Pages active:                            177638.
Pages wired down:                        202070.
Pages purgeable:                              4.
"Translation faults":               24489930246.
File-backed pages:                       105555.
Anonymous pages:                         248217.
Pages occupied by compressor:            446422.
Swapins:                              336507667.
`);
  assert.equal(v.page, 16384);
  assert.equal(v.free, 4143 * 16384);
  assert.equal(v.wired, 202070 * 16384);
  assert.equal(v.anon, 248217 * 16384);
  assert.equal(v.compressed, 446422 * 16384);
  assert.equal(v.swapins, 336507667);
  const s = S.parseSysctl('vm.swapusage: total = 11264.00M  used = 9902.50M  free = 1361.50M  (encrypted)\nkern.memorystatus_level: 34\nkern.memorystatus_vm_pressure_level: 2\n');
  assert.equal(s.swap.total, 11264 * 1048576);
  assert.equal(s.swap.used, Math.round(9902.5 * 1048576));
  assert.equal(s.freePct, 34);
  assert.equal(s.pressure, 'waspada');
});

test('df keeps Data volume and external volumes', () => {
  const d = S.parseDf(`Filesystem     1024-blocks      Used Available Capacity iused     ifree %iused  Mounted on
/dev/disk3s1s1   482746452  12262948  21919592    36%  458115 219195920    0%   /
/dev/disk3s6     482746452  11535428  21919592    35%      11 219195920    0%   /System/Volumes/VM
/dev/disk3s5     482746452 424904648  21919592    96% 4152284 219195920    2%   /System/Volumes/Data
/dev/disk5s1     100000      50000     50000    50%  1 2 0%   /Volumes/My Disk
`);
  assert.deepEqual(d.map(x => x.name), ['Macintosh HD', 'My Disk']);
  assert.equal(d[0].free, 21919592 * 1024);
  assert.equal(d[0].pct, 95.5);
  assert.equal(d[1].pct, 50);
  assert.deepEqual(S.parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 400 600 40% /\n').map(x => x.mount), ['/']);
});

test('pmset batt + therm', () => {
  const b = S.parseBatt("Now drawing from 'AC Power'\n -InternalBattery-0 (id=7209059)\t100%; finishing charge; 0:00 remaining present: true\n");
  assert.equal(b.pct, 100); assert.equal(b.ac, true); assert.equal(b.charging, true);
  const d = S.parseBatt("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t57%; discharging; 3:12 remaining present: true\n");
  assert.equal(d.ac, false); assert.equal(d.charging, false); assert.equal(d.remainingMin, 192);
  assert.equal(S.parseBatt("Now drawing from 'AC Power'\n"), null, 'desktop Mac: no battery');
  assert.equal(S.parseTherm('Note: No thermal warning level has been recorded\n').state, 'normal');
  const t = S.parseTherm('CPU_Scheduler_Limit \t= 100\nCPU_Available_CPUs \t= 8\nCPU_Speed_Limit \t= 70\n');
  assert.equal(t.speedLimit, 70); assert.equal(t.state, 'dibatasi');
});

test('netstat -ib sums real interfaces, skips loopback/bridges', () => {
  const n = S.parseNetstat(`Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                      32974318     0 58888931707 32974318     0 58888931707     0
lo0        16384 127           localhost       32974318     - 58888931707 32974318     - 58888931707     -
en0        1500  <Link#12>   aa:bb:cc:dd:ee:ff  100     0       5000      80     0       3000     0
en0        1500  192.168.1     192.168.1.5      100     -       5000      80     -       3000     -
bridge0    1500  <Link#10>   36:29:d0:46:bd:00  9     0       999      9     0       999     0
utun3      1380  <Link#20>                      10     0        700      10     0        300     0
en5*       1500  <Link#13>   aa:bb:cc:dd:ee:00  1     0        11       1     0         22     0
`);
  assert.equal(n.rx, 5011); assert.equal(n.tx, 3022);
  assert.equal(n.ifaces.en0.ip, '192.168.1.5');
  assert.equal(n.ifaces.en0.rx, 5000);
});

test('ps top by cpu and ram', () => {
  const p = S.parsePs('  PID  %CPU    RSS COMM\n91282  86.4 182864 node\n25067  23.9  985040 Google Chrome Helper (Aperitif)\n  168  1.7  54928 WindowServer\n', 2);
  assert.deepEqual(p.byCpu.map(x => x.pid), [91282, 25067]);
  assert.equal(p.byRam[0].name, 'Google Chrome Helper (Aperitif)');
  assert.equal(p.byRam[0].rss, 985040 * 1024);
  assert.equal(p.count, 3);
});

test('snapshot, history ring and endpoint over HTTP', async t => {
  const snap = await S.snapshot();
  assert.ok(snap.mem.total > 0);
  assert.ok(Array.isArray(snap.history.cpu));
  assert.ok(snap.health.score >= 0 && snap.health.score <= 100);
  await S._test.tick();
  assert.ok(S.history().t.length >= 2);
  assert.ok(S.isActive());

  const http = await import('node:http');
  const net = await import('node:net');
  const { spawn } = await import('node:child_process');
  const port = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const home = path.join(tmp, 'srv');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, roots: [tmp], token: 'demotoken' }));
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '../server/index.js')], { env: { ...process.env, KANTOR_HOME: home, KANTOR_DEMO: '1' }, stdio: 'ignore' });
  t.after(() => child.kill());
  const call = (p, auth = true) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, headers: auth ? { Authorization: 'Bearer demotoken' } : {} }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, json: b && b[0] !== '<' ? JSON.parse(b) : null })); });
    r.on('error', reject); r.end();
  });
  for (let i = 0; ; i++) { try { await call('/api/state'); break; } catch { if (i > 50) throw new Error('daemon tidak jalan'); await new Promise(r => setTimeout(r, 200)); } }
  assert.equal((await call('/api/sysmon', false)).status, 401);
  const r = await call('/api/sysmon');
  assert.equal(r.status, 200);
  assert.ok(r.json.mem.total > 0 && r.json.host && r.json.cpu.count > 0);
  assert.ok(Array.isArray((await call('/api/sysmon/history?min=5')).json.t));
  const pr = (await call('/api/sysmon/procs')).json;
  assert.ok(Array.isArray(pr.byCpu) && Array.isArray(pr.groups));
  const h = (await call('/api/sysmon/history?min=5&series=cpu,cores,gpu&points=50')).json;
  assert.ok(Array.isArray(h.cpu) && Array.isArray(h.c0) && h.step > 0);
  assert.ok(Array.isArray((await call('/api/sysmon/events')).json.events));
});

test('sysctl static info: chip, P/E cores, boot time', () => {
  const i = S.parseSysInfo('hw.model: Mac17,4\nmachdep.cpu.brand_string: Apple M5\nkern.boottime: { sec = 1791786841, usec = 21184 } Mon Oct 12\nhw.memsize: 17179869184\nhw.perflevel0.logicalcpu: 4\nhw.perflevel0.name: Super\nhw.perflevel1.logicalcpu: 6\nhw.perflevel1.name: Efficiency\n');
  assert.equal(i.model, 'Mac17,4'); assert.equal(i.chip, 'Apple M5');
  assert.deepEqual(i.levels, [{ name: 'Super', cores: 4, kind: 'P' }, { name: 'Efficiency', cores: 6, kind: 'E' }]);
  assert.equal(i.bootAt, 1791786841000); assert.equal(i.memsize, 17179869184);
});

test('ioreg: battery, gpu, disk io', () => {
  const b = S.parseSmartBattery(`+-o AppleSmartBattery  <class AppleSmartBattery>
    {
      "CurrentCapacity" = 87
      "TimeRemaining" = 245
      "InstantAmperage" = 18446744073709550616
      "ExternalConnected" = No
      "IsCharging" = No
      "AppleRawMaxCapacity" = 5564
      "DesignCapacity" = 5760
      "CycleCount" = 56
      "Temperature" = 3083
      "Voltage" = 13000
      "PermanentFailureStatus" = 0
      "AdapterDetails" = {"Watts"=35,"Name"="35W USB-C Power Adapter "}
    }`);
  assert.equal(b.pct, 87); assert.equal(b.ac, false); assert.equal(b.state, 'baterai');
  assert.equal(b.remainingMin, 245); assert.equal(b.cycles, 56); assert.equal(b.health, 96.6);
  assert.equal(b.tempC, 30.8); assert.equal(b.watts, -13); assert.equal(b.adapter, null); assert.equal(b.condition, 'normal');
  assert.equal(S.parseSmartBattery(''), null);
  const g = S.parseGpu('"model" = "Apple M5"\n"gpu-core-count" = 10\n"PerformanceStatistics" = {"In use system memory"=539459584,"Device Utilization %"=31,"Renderer Utilization %"=30,"Tiler Utilization %"=19}\n');
  assert.deepEqual([g.util, g.renderer, g.mem, g.name, g.cores], [31, 30, 539459584, 'Apple M5', 10]);
  assert.equal(S.parseGpu('nothing'), null);
  const d = S.parseDiskIO('"Statistics" = {"Operations (Write)"=20,"Bytes (Read)"=1000,"Bytes (Write)"=500,"Operations (Read)"=7}\n"Statistics" = {"Bytes (Read)"=1,"Bytes (Write)"=2,"Operations (Read)"=1,"Operations (Write)"=1}\n');
  assert.deepEqual(d, { rb: 1001, wb: 502, ro: 8, wo: 21 });
});

test('top header, conns, wifi, ps grouping + agents', () => {
  assert.deepEqual(S.parseTopHead('Processes: 638 total, 31 running, 3 stuck, 604 sleeping, 4730 threads \n'), { procs: 638, running: 31, threads: 4730 });
  assert.deepEqual(S.parseConns('tcp4 0 0 a b ESTABLISHED\ntcp4 0 0 a b ESTABLISHED\ntcp4 0 0 *.80 *.* LISTEN\n'), { established: 2, listen: 1 });
  assert.equal(S.parseWifi('  SSID : <redacted>\n').ssid, null);
  assert.equal(S.parseWifi('  SSID : Rumah\n').ssid, 'Rumah');
  const p = S.parsePs('  PID  PPID  %CPU    RSS COMM\n10 1 50.0 1000 claude\n11 1 20.0 2000 claude\n12 1 5.0 100 Google Chrome Helper (Renderer)\n13 1 1.0 100 Google Chrome\n14 1 3.0 50 tmux\n');
  assert.equal(p.agents.cpu, 73); assert.equal(p.agents.kinds.claude.n, 2); assert.equal(p.agents.kinds.tmux.cpu, 3);
  const ch = p.groups.find(x => x.name === 'Google Chrome');
  assert.equal(ch.n, 2); assert.equal(ch.cpu, 6);
  assert.equal(p.groups.find(x => x.name === 'claude').agent, 'claude');
});

test('health score and history rings', () => {
  assert.equal(S.healthScore({ cpu: 10, ram: 40 }).score, 100);
  const h = S.healthScore({ cpu: 95, pressure: 'kritis', diskPct: 97, thermal: 'panas' });
  assert.ok(h.score < 30); assert.equal(h.status, 'buruk'); assert.ok(h.reasons.length >= 4);
  const r = S.history(60, { series: ['cpu', 'cores', 'nope'], points: 10 });
  assert.ok('cpu' in r && 'c0' in r && !('nope' in r));
  assert.ok(r.t.length <= 20);
});

test('per-process: nettop, gpu clients, top power, topApps', () => {
  assert.deepEqual(S.parseNettop(',bytes_in,bytes_out,\nlaunchd.1,0,0,\nGoogle Chrome H.25067,500,20,\n'), [{ pid: 1, name: 'launchd', rin: 0, rout: 0 }, { pid: 25067, name: 'Google Chrome H', rin: 500, rout: 20 }]);
  const g = S.parseGpuClients('+-o AGXDeviceUserClient\n  |     "AppUsage" = ({"API"="Metal","accumulatedGPUTime"=100},{"accumulatedGPUTime"=50})\n  |     "IOUserClientCreator" = "pid 168, WindowServer"\n+-o AGXDeviceUserClient\n  |     "AppUsage" = ({"accumulatedGPUTime"=5})\n  |     "IOUserClientCreator" = "pid 168, WindowServer"\n');
  assert.deepEqual(g, [{ pid: 168, name: 'WindowServer', ns: 155 }]);
  const t = S.parseTopPower('Processes: 600 total, 3 running, 4000 threads\nPID    COMMAND          POWER\n1 node 0.0\nProcesses: 638 total, 31 running, 4730 threads\nPID    COMMAND          POWER\n47011  node             122.2\n58889  Google Chrome He 64.8 \n');
  assert.equal(t.counts.threads, 4730);
  assert.deepEqual(t.rows.map(r => r.power), [122.2, 64.8]);
  const top = S.topApps([{ name: 'Google Chrome Helper (Renderer)', rss: 3 }, { name: 'Google Chrome', rss: 2 }, { name: 'node', rss: 4 }, { name: 'x', rss: 0 }], 'rss');
  assert.deepEqual(top.map(x => [x.name, x.value, x.n]), [['Google Chrome', 5, 2], ['node', 4, 1]]);
});
