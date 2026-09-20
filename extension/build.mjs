import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const noVersionBump = process.argv.includes('--no-version-bump');
const outdir = 'dist';

if (!watch && !noVersionBump) {
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const versionParts = pkg.version.split('.').map(Number);
    versionParts[1] += 1;
    versionParts[2] = 0;
    const newVersion = versionParts.join('.');
    pkg.version = newVersion;
    writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n', 'utf8');

    const manifest = JSON.parse(readFileSync('public/manifest.json', 'utf8'));
    manifest.version = newVersion;
    writeFileSync('public/manifest.json', JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(`Incremented version to ${newVersion}`);
  } catch (e) {
    console.error('Failed to auto-increment version:', e);
  }
}

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const entries = {
  background: 'src/background/index.ts',
  content: 'src/content/index.ts',
  popup: 'src/popup/popup.tsx',
  // Emits dist/sidebar.js plus dist/sidebar.css — esbuild splits the imported
  // stylesheet out beside the entry, and public/ carries no sidebar.css to clobber it.
  sidebar: 'src/sidebar/index.tsx',
  // Runs in the page's own JS world (manifest "world": "MAIN"). Separate
  // entry because it must not pull in anything that expects the extension
  // APIs -- it has none of them.
  pagehook: 'src/pagehook/index.ts',
};

const shared = {
  bundle: true,
  format: 'iife',
  target: ['firefox115', 'chrome109'],
  logLevel: 'info',
  sourcemap: watch ? 'inline' : false,
  jsx: 'automatic',
  jsxImportSource: 'preact',
  // Font files are copied verbatim by copyStatic(); leave their url() alone
  // rather than having esbuild try to resolve them from src/.
  external: ['*.woff2'],
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
