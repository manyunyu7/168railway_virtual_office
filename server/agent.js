// Tools exposed to Claude sessions through the `kantor` MCP server.
import { officeForCwd, officeModel } from './offices.js';
import { bus } from './live.js';
import * as st from './store.js';
import { live, whoOf, serialize } from './live.js';
import { startShift, setPermMode, sessionAction } from './tmux.js';
import { isDialogError, queueMode, MODE_WAIT_MS } from './modeq.js';
import { startMeeting } from './meetings.js';
import { saveFromPath, mediaMarkdown } from './media.js';
import { addShow } from './shows.js';
import { sendToOwner, captureScreen } from './attachments.js';
import { agentList, agentRun, agentLog, agentStop } from './procs.js';
import { config } from './config.js';
import { globalDb, one } from './db.js';
import * as dm from './dm.js';
import * as tunggu from './tunggu.js';
import * as budget from './budget.js';
import { DENAH_TOOLS, DENAH_NAMES, callDenah } from './denah-tools.js';
import { RULE_TOOLS, RULE_NAMES, callRule } from './aturan-tools.js';
import { PRATINJAU_TOOLS, PRATINJAU_NAMES, callPratinjau } from './pratinjau.js';
import { boardForRole, resolveBoard, listBoards, colIn } from './boards.js';

// from strictest to loosest; a manager can hand out its own mode or a stricter one
const MODE_RANK = { plan: 0, default: 1, acceptEdits: 2, auto: 3, bypassPermissions: 4 };
const MODE_NAMES = Object.keys(MODE_RANK);

export const TOOLS = [
  { name: 'board_list', description: 'Daftar papan (board) kantor dan kartu di satu papan (tanpa yang diarsipkan). Kantor bisa punya beberapa papan (mis. Utama untuk dev, Kreatif untuk tim kreatif), tiap papan punya kolom sendiri; tiap kolom punya jenis (antre|siap|dikerjakan|review|selesai). Tanpa papan: papan bawaanmu. papan="semua" = kartu semua papan. Bisa difilter kolom, role, atau repo.',
    inputSchema: { type: 'object', properties: { papan: { type: 'string', description: 'id atau nama papan (board). Kosong = papan bawaanmu (papan yang dipetakan ke ruangan/role-mu, kalau tidak ada: Utama). "semua" = semua papan.' }, col: { type: 'string', description: 'nama kolom papan itu, atau jenis kolom (antre|siap|dikerjakan|review|selesai)' }, who: { type: 'string', description: 'id role' }, repo: { type: 'string' }, mine: { type: 'boolean', description: 'hanya kartu milikku' } } } },
  { name: 'card_get', description: 'Detail satu kartu: deskripsi, checklist, komentar, riwayat.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'card_create', description: 'Buat kartu baru di sebuah papan (bawaan: papan untuk ruangan/role-mu, kalau tidak ada: Utama). col = nama kolom papan itu atau jenisnya (mis. "siap", "dikerjakan").', inputSchema: { type: 'object', properties: {
    title: { type: 'string' }, papan: { type: 'string', description: 'id atau nama papan (board). Kosong = papan bawaanmu (papan yang dipetakan ke ruangan/role-mu, kalau tidak ada: Utama). Lihat board_list untuk daftar papan.' }, publish_at: { type: 'string', description: 'tanggal tayang YYYY-MM-DD (konten kreatif)' }, desc: { type: 'string' }, who: { type: 'string', description: 'id role yang ditugaskan' }, repo: { type: 'string', description: 'id ruangan/repo' },
    prio: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] }, col: { type: 'string' }, checklist: { type: 'array', items: { type: 'string' } }, epic_id: { type: 'string', description: 'id kartu epic induk' }, start: { type: 'string', description: 'tanggal mulai YYYY-MM-DD' }, due: { type: 'string', description: 'tenggat YYYY-MM-DD' }, est_days: { type: 'number', description: 'estimasi hari kerja' }, progress: { type: 'number', description: '0-100' }, labels: { type: 'array', items: { type: 'string' }, description: 'nama label; yang belum ada dibuat' }, deps: { type: 'array', items: { type: 'string' }, description: 'id kartu yang harus selesai dulu (mengganti daftar lama)' }, milestone: { type: 'boolean' } }, required: ['title'] } },
  { name: 'card_update', description: 'Ubah kartu: pindah kolom (col = nama kolom di papan kartu itu, atau jenisnya: antre|siap|dikerjakan|review|selesai), pindah papan (papan; kolom ikut jenis yang sama kalau col kosong), tanggal tayang (publish_at), ganti penugasan, prioritas, deskripsi, jadwal (start/due/est_days untuk timeline Gantt), progres, label, dependensi, milestone, atau tandai terblokir (blocked: alasan; kosongkan untuk melepas).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, col: { type: 'string' }, papan: { type: 'string', description: 'id/nama papan tujuan bila kartu dipindah ke papan lain' }, publish_at: { type: 'string', description: 'tanggal tayang YYYY-MM-DD; kosongkan untuk menghapus' }, who: { type: 'string' }, prio: { type: 'string' }, title: { type: 'string' }, desc: { type: 'string' }, blocked: { type: 'string' }, start: { type: 'string', description: 'tanggal mulai YYYY-MM-DD' }, due: { type: 'string', description: 'tenggat YYYY-MM-DD' }, est_days: { type: 'number', description: 'estimasi hari kerja' }, progress: { type: 'number', description: '0-100' }, labels: { type: 'array', items: { type: 'string' }, description: 'nama label; yang belum ada dibuat' }, deps: { type: 'array', items: { type: 'string' }, description: 'id kartu yang harus selesai dulu (mengganti daftar lama)' }, milestone: { type: 'boolean' } }, required: ['id'] } },
  { name: 'card_check', description: 'Centang/batalkan item checklist. Tunjuk item dengan nomor urut (mulai 1, seperti di daftar hasilnya), id item, atau teks/potongan teksnya (huruf besar-kecil tidak berpengaruh); isi `item` bila tidak yakin yang mana (angka atau teks sama-sama diterima). Tanpa done: dibalik. Teks yang tidak cocok dengan item mana pun (tanpa nomor/id) menambah item baru. Bila item tidak ketemu, hasilnya daftar item kartu itu (id, nomor, teks, status) supaya bisa langsung dicoba lagi. id kartu boleh dengan #, huruf kecil, atau awalannya yang unik.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, item: { description: 'nomor urut (mulai 1), id item, atau potongan teks' }, nomor: { type: 'integer', description: 'nomor urut item, mulai 1' }, text: { type: 'string', description: 'teks item (atau potongannya); item baru bila tidak ada yang cocok' }, index: { type: 'integer', description: 'lama: urutan mulai 0; lebih baik pakai nomor' }, done: { type: 'boolean' } }, required: ['id'] } },
  { name: 'card_comment', description: 'Tulis komentar di kartu (temuan, pertanyaan, hasil).', inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } },
  { name: 'wiki_search', description: 'Cari halaman wiki kantor.', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
  { name: 'wiki_read', description: 'Baca halaman wiki berdasarkan judul atau slug. Tanpa argumen: daftar semua halaman.', inputSchema: { type: 'object', properties: { page: { type: 'string' } } } },
  { name: 'wiki_write', description: 'Buat atau ganti seluruh isi halaman wiki (markdown, link antarhalaman pakai [[Judul]]; gambar `![alt](url)`; video jadi pemutar dengan `![nama](/api/offices/<kantor>/media/<id>.mp4)` atau tautan `[📎 nama.mp4](url media)`; PDF jadi kartu pratinjau dengan `![nama](/api/offices/<kantor>/media/<id>.pdf)`, dokumen markdown/teks dengan `![nama](…/media/<id>.md)` (tautan `[📎 nama.pdf|md|txt](url media)` juga ikut); tautan YouTube di baris sendiri jadi embed). Setiap simpan tercatat sebagai revisi.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, summary: { type: 'string', description: 'ringkasan perubahan' }, parent: { type: 'string', description: 'judul atau slug halaman induk (halaman ini jadi sub-halamannya)' }, icon: { type: 'string', description: 'satu emoji' } }, required: ['title', 'body'] } },
  { name: 'playbook_list', description: 'Playbook (prosedur baku, mis. deploy, rilis, rollback) yang kamu pegang. Baca isinya dengan wiki_read sebelum mengerjakan tugas yang cocok, lalu ikuti langkahnya.', inputSchema: { type: 'object', properties: { semua: { type: 'boolean', description: 'true = semua playbook kantor, bukan hanya milikmu' } } } },
  { name: 'playbook_usul', description: 'Usulkan perubahan isi playbook (kamu tidak boleh menulisnya langsung). Kirim isi lengkap versi barumu dan alasannya; pengguna menerima atau menolak.',
    inputSchema: { type: 'object', properties: { page: { type: 'string', description: 'judul atau slug playbook' }, body: { type: 'string', description: 'isi lengkap versi baru (markdown)' }, alasan: { type: 'string' } }, required: ['page', 'body', 'alasan'] } },
  { name: 'wiki_tree', description: 'Struktur wiki sebagai pohon: halaman beserta sub-halamannya.', inputSchema: { type: 'object', properties: {} } },
  { name: 'attach_file', description: 'Lampirkan file yang sudah kamu buat (gambar, PDF, CSV, dll; harus di folder kantor atau /tmp) ke kartu dan/atau halaman wiki. Gambar, video (mp4/webm/mov/m4v), PDF, dan dokumen .md/.markdown/.txt di wiki tampil di halaman (video jadi pemutar, PDF dan dokumen jadi kartu pratinjau dengan penampil layar penuh), file lain jadi tautan.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, card: { type: 'string', description: 'id kartu' }, wiki: { type: 'string', description: 'judul atau slug halaman wiki' }, caption: { type: 'string' } }, required: ['path'] } },
  { name: 'notes_list', description: 'Daftar catatan umum kantor (notes). Bisa dicari.', inputSchema: { type: 'object', properties: { q: { type: 'string' }, tag: { type: 'string' } } } },
  { name: 'note_write', description: 'Buat catatan baru, atau ubah catatan yang ada bila id diberikan.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } } },
  { name: 'role_notes_read', description: 'Baca buku catatan pribadimu (atau role lain bila role diisi).', inputSchema: { type: 'object', properties: { role: { type: 'string' } } } },
  { name: 'role_notes_write', description: 'Tulis buku catatan pribadimu. mode=append menambah di akhir, replace mengganti semuanya. Dibaca otomatis di awal shift berikutnya.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, mode: { type: 'string', enum: ['append', 'replace'] } }, required: ['text'] } },
  { name: 'announce', description: 'Tempel pengumuman singkat di papan pengumuman kantor.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'sessions_list', description: 'Siapa saja yang sedang bekerja di kantor ini sekarang: tiap sesi Claude yang jalan (shift role maupun sesi manual dari Terminal/VS Code), di ruangan mana, folder, status, dan apa yang sedang dikerjakan. Sesi yang memanggil ditandai kamu: true.', inputSchema: { type: 'object', properties: { room: { type: 'string', description: 'id ruangan untuk menyaring (opsional)' } } } },
  { name: 'meeting_start', description: 'Khusus manager: buka rapat di Ruang Meeting. Tiap peserta bicara bergiliran sebagai rolenya (claude -p dengan persona role dan tool hanya-baca, BUKAN sesi yang sedang jalan), lalu notulen dan tindak lanjut masuk wiki. Pakai roles_list untuk id role.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string' }, agenda: { type: 'string' }, participants: { type: 'array', items: { type: 'string' }, description: 'id role, minimal 2' }, rounds: { type: 'number', description: '1-4, bawaan 2' } }, required: ['topic', 'participants'] } },
  { name: 'tunjukkan', description: 'Buka file, folder, atau URL lokal (mis. http://localhost:5173) di layar pengguna, seperti membuka file di editor untuknya. HANYA panggil kalau pengguna MEMINTA melihat sesuatu ("coba buka", "aku mau lihat", "tunjukkan"). Pengguna mendapat notifikasi dan membukanya sendiri. path boleh relatif terhadap folder kerjamu, harus di dalam folder kantor.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, url: { type: 'string' }, catatan: { type: 'string', description: 'kalimat singkat: apa yang perlu dilihat' }, baris: { type: 'string', description: 'baris yang disorot, mis. "40-60"' } } } },
  { name: 'kirim_ke_pemilik', description: 'Kirim sebuah berkas (screenshot, gambar, video, PDF, log, dll) ke pemilik kantor; muncul di percakapan chat sesi ini di web dan app Ghina, dan pemilik mendapat notifikasi. Panggil kalau pemilik minta dikirimi file/hasil, atau hasil kerjamu paling jelas berupa berkas. path relatif terhadap folder kerjamu (boleh juga di folder kantor atau /tmp). Berkas disalin ke .kantor/outbox/.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, caption: { type: 'string', description: 'keterangan singkat yang tampil bersama berkas' } }, required: ['path'] } },
  { name: 'tangkap_layar', description: 'Ambil screenshot lalu kirim ke pemilik (seperti kirim_ke_pemilik). target=layar: seluruh layar Mac (bisa memuat hal pribadi). target=url: halaman web lokal (localhost / jaringan rumah) lewat Chrome headless. HANYA panggil kalau pemilik MEMINTA screenshot atau melihat tampilan ("coba screenshot", "kirim tampilan layarnya"); jangan pernah ambil layar atas inisiatifmu sendiri.',
    inputSchema: { type: 'object', properties: { target: { type: 'string', enum: ['layar', 'url'], description: 'bawaan layar, atau url bila url diisi' }, url: { type: 'string', description: 'untuk target url, mis. http://localhost:5173/' }, caption: { type: 'string' } } } },
  { name: 'proses_list', description: 'Daftar proses jangka panjang di kantor ini (npm run dev, php artisan serve, dll): ruangan, perintah, status (jalan/berhenti/gagal), kode keluar, dan port yang terdeteksi dari lognya.', inputSchema: { type: 'object', properties: {} } },
  { name: 'proses_jalankan', description: 'Jalankan proses. Dengan id: menjalankan perintah yang SUDAH terdaftar tanpa bertanya. Dengan room + perintah: bila perintah belum terdaftar, TIDAK dijalankan, hanya diusulkan ke pengguna yang harus menyetujuinya di dok Proses; beri tahu dia. Proses jalan di tmux, tetap hidup walau daemon restart. Setelah jalan, port-nya muncul di proses_list.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'id proses terdaftar' }, room: { type: 'string', description: 'id atau nama ruangan (untuk perintah baru)' }, perintah: { type: 'string', description: 'mis. "npm run dev"' }, nama: { type: 'string' } } } },
  { name: 'proses_log', description: 'Ekor log sebuah proses tanpa kode warna ANSI (bawaan 80 baris). Pakai untuk melihat error atau memastikan server sudah siap.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, baris: { type: 'number' } }, required: ['id'] } },
  { name: 'proses_hentikan', description: 'Hentikan proses: Ctrl-C dulu, lalu dipaksa mati setelah beberapa detik.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'pesan_ke', description: 'Kirim pesan langsung ke agen lain di kantor ini (Claude maupun Codex), tanpa menunggu balasan. Isi "ke" dengan id/nama role atau "manager". Pesan sampai ke penerima di tengah kerjanya: muncul sebagai blok "📨 pesan menunggu" di hasil tool kantor berikutnya yang dia panggil (atau diketik begitu dia idle); kalau dia belum shift, pesan disimpan sampai dia mulai. fyi=true: informasi saja, tanpa balasan dan tidak membangunkan penerima (sama dengan tool kabari). Pakai untuk memberi tahu hasil, serah-terima, atau minta bantuan kecil. Untuk pekerjaan yang harus dilacak, buat kartu (card_create); untuk jawaban yang kamu butuhkan sekarang, pakai tanya. Ada batas pesan per pasangan; tidak bisa ke diri sendiri.',
    inputSchema: { type: 'object', properties: { ke: { type: 'string', description: 'id atau nama role penerima, atau "manager"' }, teks: { type: 'string', description: 'isi pesan, singkat dan jelas; jangan menempel berkas panjang (pakai wiki/kartu lalu tautkan)' }, kartu: { type: 'string', description: 'id kartu terkait (opsional)' }, fyi: { type: 'boolean', description: 'true = hanya memberi tahu, tidak minta balasan dan tidak memicu giliran penerima' } }, required: ['ke', 'teks'] } },
  { name: 'kabari', description: 'Beri tahu agen lain tanpa meminta balasan (FYI): hasil, perubahan, peringatan. Penerima tidak dibangunkan dan tidak perlu membalas; pesan muncul di pengingat tool kantornya atau diketik bersama pesan lain. Lebih murah daripada pesan_ke karena tidak membuka giliran balasan.',
    inputSchema: { type: 'object', properties: { ke: { type: 'string', description: 'id atau nama role penerima, atau "manager"' }, teks: { type: 'string', description: 'isi kabar, singkat' }, kartu: { type: 'string', description: 'id kartu terkait (opsional)' } }, required: ['ke', 'teks'] } },
  { name: 'siaran', description: 'Kirim satu pesan ke beberapa role sekaligus (ke:["bayu","sinta"] atau ke:"semua"). Tiap penerima mendapat pesan sendiri; fyi=true berarti informasi saja tanpa balasan. Pakai ini alih-alih pesan_ke berkali-kali dengan isi sama. Manager dibatasi jumlah pesan keluar per giliran (dm.maxPerTurn); siaran dihitung satu.',
    inputSchema: { type: 'object', properties: { ke: { description: 'daftar id/nama role, atau "semua"', oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] }, teks: { type: 'string' }, fyi: { type: 'boolean', description: 'true = informasi saja, tanpa balasan' }, kartu: { type: 'string', description: 'id kartu terkait (opsional)' } }, required: ['ke', 'teks'] } },
  { name: 'tanya', description: 'Kirim pertanyaan ke agen lain lalu TUNGGU balasannya (tool ini baru kembali setelah dibalas atau waktu habis). Mengembalikan isi balasan, atau status "belum dibalas" bila lewat timeout (balasan yang datang terlambat masuk ke sesimu sebagai pesan). Pakai hanya bila kamu tidak bisa lanjut tanpa jawaban itu; sebut konteks lengkap karena penerima tidak melihat percakapanmu. Bawaan menunggu 300 detik, maksimal 900.',
    inputSchema: { type: 'object', properties: { ke: { type: 'string', description: 'id atau nama role penerima, atau "manager"' }, teks: { type: 'string', description: 'pertanyaan beserta konteks yang cukup' }, kartu: { type: 'string', description: 'id kartu terkait (opsional)' }, timeout_detik: { type: 'number', description: 'lama menunggu, 5-900, bawaan 300' } }, required: ['ke', 'teks'] } },
  { name: 'balas', description: 'Balas pesan atau pertanyaan yang masuk kepadamu dari agen lain (pesan berbentuk "[Pesan dari … · id m123]"). Beri id pesan itu. Kalau pengirim sedang menunggu lewat tanya, jawabanmu langsung sampai kepadanya. Setiap pesan hanya dibalas sekali (balasan kedua mengembalikan balasan pertama); id salah dijawab dengan daftar pesan yang menunggu. FYI dan balasan tidak perlu dibalas.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'id pesan yang dibalas, mis. m1a2b3c4d5' }, teks: { type: 'string', description: 'isi balasan' } }, required: ['id', 'teks'] } },
  { name: 'pesan_list', description: 'Kotak pesan agen ini: pesan langsung yang masuk dan yang kamu kirim (60 terakhir) beserta statusnya (menunggu, terkirim, dibaca, dibalas). Pesan masuk yang masih menunggu dianggap terbaca di sini dan tidak diketik lagi ke sesimu. Pesan baru juga muncul sendiri sebagai blok "📨 pesan menunggu" di hasil tool kantor. belum_dibaca=true hanya menampilkan yang baru atau yang masih perlu kamu balas.',
    inputSchema: { type: 'object', properties: { belum_dibaca: { type: 'boolean', description: 'hanya pesan baru / yang perlu dibalas' } } } },
  { name: 'tunggu_kerja', description: 'Tunggu kerja TANPA memakai giliran: kamu mengakhiri gilirannya, harness mencatat apa yang kamu tunggu dan membangunkanmu dengan satu prompt ringkas saat itu terjadi (atau saat waktu habis). Pakai ini, BUKAN sleep, polling, Monitor, atau ScheduleWakeup, kapan pun tidak ada kerja yang bisa dilanjutkan. Kejadian: kartu_masuk (kartu baru di Backlog/Siap tanpa pemilik atau untukmu), kartu_untukku (kartu ditugaskan ke kamu), pesan (pesan langsung dari agen lain), commit_baru (HEAD repo berubah; isi repo dengan id ruangan, bawaan ruanganmu), review_diminta (kartu masuk ke Review). Boleh diberi sampai (waktu ISO) dan/atau maks_menit (bawaan 180, maks 720). Setelah tool ini kembali, akhiri gilirannya dengan satu kata "menunggu" tanpa tool lain. Pesan, prompt dari pemilik, atau tawaran kerja yang masuk ke sesimu juga membatalkan tunggu; panggil lagi bila perlu.',
    inputSchema: { type: 'object', properties: { kejadian: { type: 'array', items: { type: 'string', enum: tunggu.EVENTS }, description: 'apa yang ditunggu' }, sampai: { type: 'string', description: 'waktu ISO batas menunggu, mis. 2026-10-22T09:30:00+07:00' }, maks_menit: { type: 'number', description: 'batas menunggu dalam menit, bawaan 180, maks 720' }, repo: { type: 'array', items: { type: 'string' }, description: 'untuk commit_baru: id ruangan yang dipantau (bawaan ruanganmu)' } } } },
  { name: 'roles_list', description: 'Daftar role di kantor beserta ruangan dan status shift-nya.', inputSchema: { type: 'object', properties: {} } },
  { name: 'shift_start', description: 'Khusus manager: mulai shift role lain di tmux, opsional langsung dengan tugas atau kartu (tugas langsung masuk sebagai pesan pertama). permission_mode menentukan mode izin shift itu; tanpa itu dipakai mode bawaan kantor. Kamu tidak bisa memberi mode yang lebih longgar dari modemu sendiri.',
    inputSchema: { type: 'object', properties: { role: { type: 'string' }, task: { type: 'string' }, card_id: { type: 'string' }, permission_mode: { type: 'string', enum: MODE_NAMES }, paralel: { type: 'boolean', description: 'true = buka sesi tambahan walau role ini sudah shift (kerja paralel). Tanpa ini, tugas dikirim ke sesi yang sudah jalan.' } }, required: ['role'] } },
  { name: 'shift_mode', description: 'Khusus manager: ganti mode izin shift role yang sedang jalan (sama dengan menekan Shift+Tab di terminalnya). Tidak bisa lebih longgar dari modemu sendiri.',
    inputSchema: { type: 'object', properties: { role: { type: 'string' }, permission_mode: { type: 'string', enum: MODE_NAMES } }, required: ['role', 'permission_mode'] } },
  ...DENAH_TOOLS,
  ...RULE_TOOLS,
  ...PRATINJAU_TOOLS,
];

const text = v => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

export function resolveIdentity({ office, role, sid, cwd }) {
  const o = office || (cwd ? officeForCwd(cwd) : null);
  if (!o) throw new Error('Folder ini bukan bagian dari kantor mana pun.');
  const s = sid ? live.get(sid) : null;
  const roleId = role || s?.role || null;
  const r = roleId ? st.getRole(o, roleId) : null;
  const by = r?.name || (s ? whoOf(s) : 'Sesi manual');
  return { office: o, role: r, by, sid, cwd: s?.cwd || cwd || null };
}

// the caller's live session; after /clear its id changed, so look it up through its tmux pane
function callerSession(sid) {
  if (!sid) return null;
  const s = live.get(sid);
  if (s) return s;
  const row = one(globalDb(), 'SELECT tmux FROM sessions WHERE sid = ?', sid);
  return row?.tmux ? [...live.values()].find(x => x.tmux === row.tmux && x.status !== 'ended') : null;
}
function allowMode(ident, mode) {
  if (!mode || mode === 'ikut') return;
  if (!(mode in MODE_RANK)) throw new Error(`Mode tidak dikenal: ${mode}. Pilihan: ${MODE_NAMES.join(', ')}.`);
  const mine = callerSession(ident.sid)?.permMode || 'default';
  if (MODE_RANK[mode] > (MODE_RANK[mine] ?? 1)) throw new Error(`Mode ${mode} lebih longgar dari modemu sendiri (${mine}). Minta pengguna yang memilihnya dari kantor.`);
}

/** Required text argument: a clear hint instead of a bare "kosong" error, so the agent fixes the call without asking. */
export function need(v, field, hint) {
  if (v === undefined || v === null || !String(v).trim()) throw new Error(`Isi \`${field}\` (${hint}); tadi kosong. Panggil lagi dengan ${field} berisi teks.`);
  return v;
}

/** Every kantor tool result carries a reminder when messages wait for the caller: that is how a DM reaches an agent that is mid-turn. */
export async function callTool(ident, name, a = {}) {
  const res = await runTool(ident, name, a);
  try {
    const note = dm.reminder(ident.office, ident.role?.id);
    if (note && res?.content) res.content.push({ type: 'text', text: note });
  } catch {}
  try { // from 80% of the role's budget on, every result carries a reminder
    const warn = budget.reminder(ident.office, ident.role?.id);
    if (warn && res?.content) res.content.push({ type: 'text', text: warn });
  } catch {}
  return res;
}

async function runTool(ident, name, a = {}) {
  const { office, role, by } = ident;
  const brief = c => ({ id: c.id, judul: c.title, papan: c.board, kolom: c.colName, jenis_kolom: c.colKind, untuk: c.who, repo: c.repo, prioritas: c.prio, checklist: `${c.checks.done}/${c.checks.total}`, terblokir: c.blocked || undefined, epic: c.epic || undefined, epic_induk: c.epicId || undefined, mulai: c.start || undefined, tenggat: c.due || undefined, menunggu: c.deps?.length ? c.deps : undefined, label: c.labels?.length ? c.labels : undefined, milestone: c.milestone || undefined, tayang: c.publishAt || undefined });
  const papanRow = b => ({ id: b.id, nama: b.name, kolom: b.columns.map(x => `${x.name} (${x.kind})`), ruangan: b.rooms.length ? b.rooms : undefined, role: b.roles.length ? b.roles : undefined });
  const myBoard = () => boardForRole(office, role);
  const pickBoard = v => (v === undefined || v === null || String(v).trim() === '' ? myBoard() : resolveBoard(office, v));
  switch (name) {
    case 'board_list': {
      const semua = /^(semua|all|\*)$/i.test(String(a.papan || '').trim());
      const b = semua ? null : pickBoard(a.papan);
      let cards = st.listCards(office, { board: semua ? 'all' : b.id });
      if (a.col) {
        if (b) { const i = colIn(b, a.col); cards = cards.filter(c => c.col === i); }
        else { const k = String(a.col).trim().toLowerCase(); cards = cards.filter(c => c.colKind === k || c.colName.toLowerCase() === k); }
      }
      if (a.who) cards = cards.filter(c => c.who === a.who);
      if (a.mine && role) cards = cards.filter(c => c.who === role.id);
      if (a.repo) cards = cards.filter(c => c.repo === a.repo);
      return text({ papan_ini: b ? b.id : 'semua', papan_bawaanmu: myBoard().id, papan: listBoards(office, { archived: false }).map(papanRow), kolom: b ? b.columns.map(x => x.name) : undefined, kartu: cards.map(brief) });
    }
    case 'card_get': { const c = st.getCard(office, st.resolveCardId(office, need(a.id, 'id', 'id kartu, lihat board_list'))); return text({ ...c, papan: c.board, kolom: c.colName, jenis_kolom: c.colKind }); }
    case 'card_create': { need(a.title, 'title', 'judul kartu'); const c = st.createCard(office, { ...a, board: a.papan || (a.epic_id ? undefined : myBoard().id), publishAt: a.publish_at, epicId: a.epic_id, estDays: a.est_days }, by); return text(`Kartu ${c.id} dibuat di papan ${c.boardName}, kolom ${c.colName}.`); }
    case 'card_update': {
      const whoName = a.who ? st.getRole(office, a.who)?.name : undefined;
      if (a.who && !whoName) throw new Error(`Role ${a.who} tidak ada. Pakai roles_list untuk melihat id role.`);
      const c = st.updateCard(office, st.resolveCardId(office, need(a.id, 'id', 'id kartu, lihat board_list')), { ...a, whoName, ...(a.est_days !== undefined ? { estDays: a.est_days } : {}), ...(a.papan ? { board: a.papan } : {}), ...(a.publish_at !== undefined ? { publishAt: a.publish_at } : {}) }, by);
      return text(`Kartu ${c.id} sekarang di ${c.board !== 'utama' ? `papan ${c.boardName}, ` : ''}${c.colName}${c.who ? `, untuk ${c.who}` : ''}${c.blocked ? `, terblokir: ${c.blocked}` : ''}.`);
    }
    case 'card_check': { const c = st.checkItem(office, need(a.id, 'id', 'id kartu, lihat board_list'), { text: a.text, item: a.item, nomor: a.nomor, index: a.index, done: a.done }, by); return text(c.checklist.map((x, i) => `${i + 1}. [${x.done ? 'x' : ' '}] ${x.text} (id ${x.id})`).join('\n') || '(checklist kosong)'); }
    case 'card_comment': { need(a.text, 'text', 'isi komentar'); st.commentCard(office, st.resolveCardId(office, need(a.id, 'id', 'id kartu, lihat board_list')), a.text, by); return text('Komentar ditambahkan.'); }
    case 'wiki_search': return text(st.searchWiki(office, a.q));
    case 'wiki_read': {
      if (!a.page) return text(st.listWiki(office).map(p => `${p.title} (${p.slug})`).join('\n') || '(wiki kosong)');
      const p = st.getWiki(office, a.page);
      return text(p ? `# ${p.title}\n\n${p.body}` : `Halaman "${a.page}" belum ada.`);
    }
    case 'playbook_list': {
      const list = st.listPlaybooks(office, a.semua || !role ? null : role.id);
      return text(list.length ? list.map(p => ({ judul: p.title, slug: p.slug, kapan: p.when || undefined, pemegang: p.roles, minta_persetujuan: p.approval || undefined })) : 'Belum ada playbook untukmu.');
    }
    case 'playbook_usul': {
      const p = st.getWiki(office, a.page);
      if (!p?.playbook) throw new Error(`"${a.page}" bukan playbook. Untuk halaman wiki biasa pakai wiki_write.`);
      const u = st.proposeWiki(office, p.slug, { body: a.body, reason: a.alasan }, by);
      return text(`Usulan ${u.id} untuk "${p.title}" terkirim. Pengguna akan menerima atau menolaknya; sampai itu, ikuti versi yang sekarang.`);
    }
    case 'wiki_write': {
      { const cur = st.getWiki(office, a.title); if (cur?.playbook) throw new Error(`"${cur.title}" adalah playbook dan tidak bisa ditulis langsung. Pakai playbook_usul dengan isi lengkap versi barumu dan alasannya.`); }
      const parent = a.parent ? st.getWiki(office, a.parent)?.slug : undefined;
      if (a.parent && !parent) throw new Error(`Halaman induk "${a.parent}" tidak ditemukan. Buat dulu, atau lihat wiki_tree.`);
      const p = st.saveWiki(office, { title: a.title, body: a.body, msg: a.summary, prevSlug: st.getWiki(office, a.title)?.slug, parent, icon: a.icon }, by);
      return text(`Wiki "${p.title}" disimpan (revisi ke-${p.revs})${p.crumbs.length ? `, di bawah ${p.crumbs.map(c => c.title).join(' › ')}` : ''}.`);
    }
    case 'wiki_tree': {
      const pages = st.listWiki(office);
      const tree = (parent, depth) => pages.filter(p => (p.parent || null) === parent).flatMap(p => [`${'  '.repeat(depth)}- ${p.icon ? p.icon + ' ' : ''}${p.title} (${p.slug})`, ...tree(p.slug, depth + 1)]);
      return text(tree(null, 0).join('\n') || '(wiki kosong)');
    }
    case 'attach_file': {
      if (!a.card && !a.wiki) throw new Error('Isi card dan/atau wiki sebagai tujuan lampiran.');
      const m = await saveFromPath(office, a.path, by);
      const done = [];
      if (a.card) { st.attachToCard(office, a.card, m.id, by); done.push(`kartu ${a.card}`); }
      if (a.wiki) {
        const p = st.getWiki(office, a.wiki);
        if (!p) throw new Error(`Halaman "${a.wiki}" tidak ditemukan.`);
        const embed = mediaMarkdown(m, a.caption);
        st.saveWiki(office, { slug: p.slug, title: p.title, body: `${p.body.trimEnd()}\n\n${embed}\n`, msg: `Lampiran ${m.name}` }, by);
        done.push(`wiki "${p.title}"`);
      }
      return text(`${m.name} (${Math.round(m.size / 1024)} KB) dilampirkan ke ${done.join(' dan ')}.`);
    }
    case 'notes_list': return text(st.listNotes(office, { q: a.q, tag: a.tag }).map(n => ({ id: n.id, judul: n.title, tags: n.tags, isi: n.body.slice(0, 400) })));
    case 'note_write': { need(a.body, 'body', 'isi catatan'); const n = st.saveNote(office, { id: a.id, title: a.title, body: a.body, tags: a.tags }, by); return text(`Catatan ${n.id} disimpan.`); }
    case 'role_notes_read': { const r = a.role ? st.getRole(office, a.role) : role; if (!r) throw new Error('Sesi ini tidak terikat ke role.'); return text(r.notes || '(kosong)'); }
    case 'role_notes_write': { need(a.text, 'text', 'isi catatan'); if (!role) throw new Error('Sesi ini tidak terikat ke role, jadi tidak punya buku catatan.'); st.writeRoleNotes(office, role.id, a.text, a.mode || 'append', by); return text('Buku catatan diperbarui.'); }
    case 'announce': { need(a.text, 'text', 'isi pengumuman'); st.addNews(office, a.text, by); return text('Pengumuman ditempel.'); }
    case 'sessions_list': {
      const m = officeModel(office), me = callerSession(ident.sid);
      const rows = [...live.values()].filter(x => x.office === office && x.status !== 'ended' && x.kind !== 'rapat' && (!a.room || x.room === a.room));
      const ago = t => { const d = Math.round((Date.now() - Date.parse(t || 0)) / 60000); return !t ? '-' : d < 1 ? 'baru saja' : d < 60 ? `${d} menit lalu` : `${Math.round(d / 60)} jam lalu`; };
      return text(rows.map(x => ({ id: x.sid.slice(0, 8), siapa: x.role ? st.getRole(office, x.role)?.name || x.role : (x.title && x.title !== 'Sesi belum terhubung' ? x.title : 'Sesi manual'), role: x.role || undefined,
        ruangan: m.plan.rooms.find(r => r.id === x.room)?.name || x.room || '-', folder: x.cwd ? x.cwd.replace(m.root, '.') : undefined, status: x.waiting ? 'menunggu izin' : x.status,
        menunggu: x.tunggu?.label || undefined, anggaran: x.anggaran || undefined,
        sedang: x.tool ? `${x.tool.name} ${x.tool.label || ''}`.trim() : undefined, mulai: ago(x.startedAt), asal: x.tmux ? `tmux ${x.tmux}` : x.host || 'terminal', atasan: x.boss ? st.getRole(office, x.boss)?.name || x.boss : undefined, kamu: me?.sid === x.sid || undefined })));
    }
    case 'meeting_start': {
      if (!role?.isMgr) throw new Error('Hanya manager yang boleh membuka rapat.');
      const m = startMeeting(office, { topic: a.topic, agenda: a.agenda || '', participants: a.participants || [], rounds: a.rounds || 2, chair: role.id });
      return text(`Rapat "${m.topic}" dibuka (id ${m.id}) dengan ${m.participants.length} peserta. Hasilnya masuk wiki setelah selesai; pantau di tab Rapat.`);
    }
    case 'tunjukkan': {
      const it = addShow({ office, sid: ident.sid, who: by, cwd: ident.cwd, path: a.path, url: a.url, note: a.catatan, lines: a.baris });
      return text(`${it.kind === 'url' ? it.target : it.target + (it.kind === 'folder' ? '/' : '')} sudah dikirim ke layar pengguna sebagai notifikasi; dia membukanya sendiri.`);
    }
    case 'kirim_ke_pemilik': {
      const it = await sendToOwner(ident, a.path, a.caption);
      return text(`${it.name} (${Math.round(it.size / 1024)} KB) sudah dikirim ke pemilik.`);
    }
    case 'tangkap_layar': {
      const it = await captureScreen(ident, a);
      return text(`Tangkapan ${it.name} (${Math.round(it.size / 1024)} KB) sudah dikirim ke pemilik.`);
    }
    case 'pesan_ke': return text(await dm.pesanKe(office, role, a));
    case 'kabari': return text(await dm.kabari(office, role, a));
    case 'siaran': return text(await dm.siaran(office, role, a));
    case 'tanya': return text(await dm.tanya(office, role, a));
    case 'balas': return text(await dm.balas(office, role, a));
    case 'tunggu_kerja': return text(await tunggu.daftar(callerSession(ident.sid), a));
    case 'pesan_list': return text(dm.pesanList(office, role, a));
    case 'proses_list': return text(agentList(office));
    case 'proses_jalankan': return text(agentRun(office, a));
    case 'proses_log': return text(agentLog(office, a));
    case 'proses_hentikan': return text(agentStop(office, a.id));
    case 'roles_list': {
      const active = new Set([...live.values()].filter(s => s.office === office && s.status !== 'ended').map(s => s.role));
      const m = officeModel(office);
      return text(st.listRoles(office).map(r => ({ id: r.id, nama: r.name, jabatan: r.title, ruangan: m.plan.rooms.find(x => x.id === r.room)?.name || r.room, model: r.model, ...(r.engine && r.engine !== 'claude' ? { mesin: r.engine, effort: r.effort || undefined } : {}), sedang_shift: active.has(r.id), atasan: r.reportsTo || undefined, mode_izin: [...live.values()].find(x => x.office === office && x.role === r.id && x.status !== 'ended')?.permMode || undefined })));
    }
    case 'shift_start': {
      if (!role?.isMgr) throw new Error('Hanya manager yang boleh memulai shift role lain.');
      const mode = a.permission_mode || config().defaultPermissionMode || '';
      allowMode(ident, mode);
      // the role already has a shift in a kantor terminal: hand it the task there instead of opening "Nama #2"
      const running = a.paralel ? null : [...live.values()].find(s => s.office === office && s.role === a.role && s.tmux && s.status !== 'ended');
      if (running) {
        const c = a.card_id ? st.getCard?.(office, a.card_id) : null;
        const msg = [a.task, a.card_id ? `Kartu: ${a.card_id}${c?.title ? ` "${c.title}"` : ''} (baca dengan card_get).` : ''].filter(Boolean).join('\n');
        if (msg) await sessionAction(running.sid, 'text', msg);
        return text(`${a.role} sudah shift (tmux ${running.tmux}, ${running.status === 'working' ? 'sedang bekerja, pesan masuk antrean' : 'idle'}). ${msg ? 'Tugas dikirim ke sesi itu.' : 'Tidak ada tugas yang dikirim.'} Pakai paralel: true kalau memang perlu sesi kedua.`);
      }
      const r = startShift(office, a.role, { task: a.task, cardId: a.card_id, permissionMode: a.permission_mode || null });
      return text(`Shift ${a.role} dimulai (tmux ${r.tmux}${mode ? `, mode izin ${mode}` : ''}).`);
    }
    case 'shift_mode': {
      if (!role?.isMgr) throw new Error('Hanya manager yang boleh mengganti mode izin role lain.');
      allowMode(ident, a.permission_mode);
      const target = [...live.values()].find(s => s.office === office && s.role === a.role && s.tmux && s.status !== 'ended');
      if (!target) throw new Error(`${a.role} sedang tidak shift di terminal kantor.`);
      try {
        const r = await setPermMode(target.sid, a.permission_mode);
        bus.emit('msg', { t: 'session', office, session: serialize(target) });
        return text(`Mode izin ${a.role} sekarang ${r.mode}.`);
      } catch (e) {
        if (!isDialogError(e)) throw e;
        queueMode(target, a.permission_mode, { office, who: by, label: a.role });
        return text(`Dijadwalkan: ${a.role} sedang menampilkan dialog, jadi mode ${a.permission_mode} dipasang otomatis begitu dialognya hilang (dicoba tiap beberapa detik, maks ${Math.round(MODE_WAIT_MS / 60000)} menit). Tidak perlu mengulang.`);
      }
    }
  }
  if (DENAH_NAMES.has(name)) return callDenah(ident, name, a);
  if (RULE_NAMES.has(name)) return callRule(ident, name, a);
  if (PRATINJAU_NAMES.has(name)) return callPratinjau(ident, name, a);
  throw new Error(`Tool tidak dikenal: ${name}`);
}
