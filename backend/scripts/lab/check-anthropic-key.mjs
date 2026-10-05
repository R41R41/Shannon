// usage: node check-anthropic-key.mjs [key file] [model]
// Sends one single-token request and prints only the HTTP status, the organisation the key belongs to and the
// provider's error text. No part of the key is ever printed. Exit code 0 = usable, 1 = refused.
import fs from 'node:fs';

const file = process.argv[2] ?? '/home/azureuser/.config/minebot-lab/anthropic.env';
const model = process.argv[3] ?? 'claude-sonnet-5-5';
const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const value = (name) =>
  (text.split('\n').filter((line) => line.startsWith(`${name}=`)).pop() ?? '')
    .slice(name.length + 1)
    .trim()
    .replace(/^["']|["']$/g, '');

const key = value('ANTHROPIC_API_KEY');
const workspace = value('ANTHROPIC_WORKSPACE_ID');
if (!key) {
  console.log(JSON.stringify({ status: 'key_absent', file }));
  process.exit(1);
}

const response = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    ...(workspace ? { 'anthropic-workspace-id': workspace } : {}),
  },
  body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
});
const payload = await response.json().catch(() => ({}));
console.log(
  JSON.stringify({
    status: response.status,
    model,
    organization: response.headers.get('anthropic-organization-id'),
    workspaceHeaderSent: Boolean(workspace),
    message: String(payload?.error?.message ?? '').split(key).join('[key]').slice(0, 200),
  }),
);
process.exit(response.status === 200 ? 0 : 1);
