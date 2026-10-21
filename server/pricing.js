// USD per million tokens, first-party API list prices. Cache writes are priced from
// the input rate (1.25x for the 5-minute TTL, 2x for the 1-hour TTL); cache reads
// differ per model, so they are listed explicitly.
// These are estimates of API-equivalent cost; subscription plans are billed differently.
const TABLE = [
  ['claude-fable-5-1', 10, 50, 0.25],
  ['claude-mythos-5-1', 10, 50, 0.25],
  ['claude-fable-5', 10, 50, 1],
  ['claude-mythos-5', 10, 50, 1],
  ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-opus-5', 5, 25, 0.5],
  ['claude-opus-4-8', 5, 25, 0.5],
  ['claude-opus-4-7', 5, 25, 0.5],
  ['claude-opus-4-6', 5, 25, 0.5],
  ['claude-opus-4-5', 5, 25, 0.5],
  ['claude-opus-4', 15, 75, 1.5],
  ['claude-sonnet-5-5', 2, 10, 0.2],
  ['claude-sonnet-5', 2, 10, 0.2],
  ['claude-sonnet-4', 3, 15, 0.3],
  ['claude-haiku-5-5', 0.1, 0.5, 0.01],
  ['claude-haiku-4-5', 1, 5, 0.1],
  ['claude-3', 3, 15, 0.3],
];

export function priceFor(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  const row = TABLE.find(([id]) => m === id || m.startsWith(id + '-') || m.startsWith(id + '['));
  if (row) return { model: row[0], input: row[1], output: row[2], read: row[3] };
  if (m.includes('opus')) return { model: 'opus', input: 5, output: 25, read: 0.5 };
  if (m.includes('sonnet')) return { model: 'sonnet', input: 2, output: 10, read: 0.2 };
  if (m.includes('haiku')) return { model: 'haiku', input: 0.1, output: 0.5, read: 0.01 };
  if (m.includes('fable') || m.includes('mythos')) return { model: 'fable', input: 10, output: 50, read: 0.25 };
  return null;
}

// usage: the `message.usage` object from a transcript entry
export function costOf(model, usage) {
  const p = priceFor(model);
  if (!p || !usage) return 0;
  const inp = usage.input_tokens || 0;
  const out = usage.output_tokens || 0;
  const read = usage.cache_read_input_tokens || 0;
  const cc = usage.cache_creation || {};
  let w1h = cc.ephemeral_1h_input_tokens || 0;
  let w5 = cc.ephemeral_5m_input_tokens || 0;
  if (!w1h && !w5) w5 = usage.cache_creation_input_tokens || 0;
  let usd = (inp * p.input + out * p.output + read * p.read + w5 * p.input * 1.25 + w1h * p.input * 2) / 1e6;
  if (usage.speed === 'fast') usd *= 2;
  return usd;
}

export function modelLabel(model) {
  const p = priceFor(model);
  if (!p) return model || 'tidak diketahui';
  return p.model.replace('claude-', '').replace(/-(\d)-(\d)$/, ' $1.$2').replace(/-(\d)$/, ' $1');
}
