import fs from 'node:fs';
import path from 'node:path';

// Codex subagent hooks can carry the parent's session_id with the child's
// transcript_path. Never let that path replace the parent's conversation.
export function ownedTranscript(sid, file, engine) {
  if (!file || engine !== 'codex') return file || null;
  const match = /^rollout-.*-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i.exec(path.basename(file));
  if (!match || match[1] === sid) return file;
  // Also repairs pointers saved by older daemons, including local mirrors.
  try {
    const name = fs.readdirSync(path.dirname(file)).find(n => n.startsWith('rollout-') && n.endsWith(`-${sid}.jsonl`));
    if (name) return path.join(path.dirname(file), name);
  } catch { /* A remote or not-yet-created file cannot be recovered locally. */ }
  return null;
}
