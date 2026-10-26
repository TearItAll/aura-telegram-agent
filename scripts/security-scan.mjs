import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Offline heuristics, not a proof that all secrets or personal data are absent.
// Findings contain locations and rule names only, never matched values.
const rules = [
  ['google-api-key', /AIza[0-9A-Za-z_-]{30,}/g],
  ['telegram-bot-token', /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ['provider-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ['google-oauth-secret', /GOCSPX-[A-Za-z0-9_-]{12,}/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g],
  ['email-address', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ['long-numeric-identifier', /\b\d{9,}\b/g],
  ['literal-sensitive-assignment', /\b(?:TELEGRAM_BOT_TOKEN|WEBHOOK_SECRET|ALLOWED_USER_ID|GEMINI_API_KEY|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|TOKEN_ENCRYPTION_KEY)\s*[:=]\s*["'`](?!REPLACE_|<|["'`])[^"'`\r\n]+["'`]/g]
];

export function scanText(text, filename = 'input') {
  const findings = [];
  for (const [rule, pattern] of rules) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      findings.push({ file: filename, line: text.slice(0, match.index).split('\n').length, rule });
    }
  }
  return findings;
}

async function filesBelow(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.wrangler', 'private', 'work'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(full));
    else if (['.gitignore', '.gitattributes'].includes(entry.name) || /\.(?:js|mjs|json|jsonc|toml|md|sql|patch|example|yaml|yml)$/.test(entry.name)) files.push(full);
  }
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const files = await filesBelow(root);
  const findings = [];
  for (const file of files) {
    findings.push(...scanText(await readFile(file, 'utf8'), path.relative(root, file)));
  }
  console.log(JSON.stringify({ scannedFiles: files.length, findings, note: 'Offline heuristic scan; manual review is also required.' }, null, 2));
  if (findings.length) process.exitCode = 1;
}
