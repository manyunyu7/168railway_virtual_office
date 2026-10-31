// Client-facing launch form. Engine adapters remain server-side; clients render
// this schema without needing to recognize the adapter's id.
import { bins } from './tmux.js';
import { codexBin, codexModels, CODEX_MODES } from './codex.js';
import { agyModels, AGY_MODES } from './antigravity.js';

const permissionLabels = {
  '': 'Default kantor', ikut: 'Ikuti pengaturan CLI', default: 'Tanya dulu',
  acceptEdits: 'Edit file otomatis', auto: 'Auto', plan: 'Hanya merencanakan',
  readOnly: 'Hanya baca', bypassPermissions: 'Lewati semua izin',
};
const permissions = ids => ids.map(id => ({ id, name: permissionLabels[id] || id,
  ...(id === 'bypassPermissions' ? { warning: 'Agen dapat menjalankan perintah tanpa meminta izin.' } : {}) }));

export function buildEngineCatalog({ claudeAvailable, codex, antigravity }) {
  return { version: 1, defaultEngine: 'claude', engines: [
    { id: 'claude', name: 'Claude Code', available: !!claudeAvailable,
      defaultModel: 'sonnet', defaultEffort: '', defaultPermissionMode: '',
      models: [['sonnet', 'Sonnet 5.5'], ['opus', 'Opus 5.5'], ['haiku', 'Haiku 5.5'], ['fable', 'Fable 5.1']]
        .map(([slug, name]) => ({ slug, name })),
      allowDefaultModel: false, supportsEffort: false,
      permissionModes: permissions(['', 'ikut', 'default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions']) },
    { id: 'codex', name: 'OpenAI Codex', available: !!codex.available,
      defaultModel: codex.default?.model || '', defaultEffort: codex.default?.effort || '',
      defaultPermissionMode: 'default', models: codex.models || [],
      allowDefaultModel: true, supportsEffort: true, efforts: codex.efforts || [],
      permissionModes: permissions(CODEX_MODES) },
    { id: 'antigravity', name: 'Gemini (Antigravity)', available: !!antigravity.available,
      defaultModel: '', defaultEffort: '', defaultPermissionMode: 'default',
      models: (antigravity.models || []).filter(m => m.slug.startsWith('gemini-')),
      allowDefaultModel: true, supportsEffort: false, permissionModes: permissions(AGY_MODES),
      ...(antigravity.error ? { error: antigravity.error } : {}) },
  ] };
}

export async function engineCatalog() {
  const [codex, antigravity] = await Promise.all([codexModels(), agyModels()]);
  return buildEngineCatalog({ claudeAvailable: !!bins().claude,
    codex: { ...codex, available: !!codexBin() }, antigravity });
}
