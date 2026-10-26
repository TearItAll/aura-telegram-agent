import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { build } from 'esbuild';

// A closed module list avoids reading unrelated parent-directory configuration.
// No test harness, environment file, credentials or deploy configuration is bundled.
const names = ['worker.js', 'src/task-plan-actions.js', 'src/task-plan-revisions.js', 'src/daily-news.js', 'src/news-ai.js'];
const contents = new Map(await Promise.all(names.map(async name => [name,
  await readFile(new URL('../' + name, import.meta.url), 'utf8')])));
const result = await build({
  entryPoints: ['worker.js'], bundle: true, format: 'esm', platform: 'neutral',
  target: 'es2022', charset: 'utf8', write: false, sourcemap: false, tsconfigRaw: {},
  plugins: [{ name: 'reviewed-aura-modules', setup(context) {
    context.onResolve({ filter: /.*/ }, args => {
      const name = args.kind === 'entry-point' ? path.posix.normalize(args.path) :
        path.posix.normalize(path.posix.join(path.posix.dirname(args.importer), args.path));
      if (!contents.has(name)) return { errors: [{ text: 'Unreviewed module import rejected' }] };
      return { path: name, namespace: 'aura-reviewed' };
    });
    context.onLoad({ filter: /.*/, namespace: 'aura-reviewed' }, args => ({
      contents: contents.get(args.path), loader: 'js'
    }));
  } }]
});
const code = result.outputFiles[0].text;
if (code.includes('/__test/')) throw new Error('Test harness must never enter the production bundle');
const output = new URL('../dist/worker.js', import.meta.url);
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await writeFile(output, code, 'utf8');
console.log(JSON.stringify({ output: 'dist/worker.js', bytes: Buffer.byteLength(code),
  sha256: createHash('sha256').update(code).digest('hex'), deployed: false }));
