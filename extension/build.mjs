import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const entries = {
  background: 'src/background/index.ts',
  content: 'src/content/index.ts',
  popup: 'src/popup/popup.ts',
};

const shared = {
  bundle: true,
  format: 'iife',
  target: ['firefox115', 'chrome109'],
  logLevel: 'info',
  sourcemap: watch ? 'inline' : false,
};

function copyStatic() {
  cpSync('public', outdir, { recursive: true });
}

if (watch) {
  const ctxs = await Promise.all(
    Object.entries(entries).map(([name, entry]) =>
      context({ ...shared, entryPoints: [entry], outfile: `${outdir}/${name}.js` })),
  );
  await Promise.all(ctxs.map((c) => c.watch()));
  copyStatic();
  console.log('watching src/ + public/ …');
} else {
  await Promise.all(
    Object.entries(entries).map(([name, entry]) =>
      build({ ...shared, entryPoints: [entry], outfile: `${outdir}/${name}.js` })),
  );
  copyStatic();
  console.log('built -> dist/');
}
