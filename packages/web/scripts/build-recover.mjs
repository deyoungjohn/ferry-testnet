import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const entry = fileURLToPath(
  new URL('../src/recover/standalone.ts', import.meta.url),
);
const cssPath = fileURLToPath(
  new URL('../src/recover/recover.css', import.meta.url),
);

const result = await build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  conditions: ['ferry-source', 'import', 'module', 'default'],
  minify: true,
  legalComments: 'none',
  define: {
    'import.meta.env': '{}',
    'process.env.NODE_ENV': '"production"',
  },
});

const js = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
const css = await readFile(cssPath, 'utf8');

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark" />
    <title>Ferry recovery</title>
    <!-- prettier-ignore -->
    <style>${css}</style>
  </head>
  <body>
    <div id="recover-app"></div>
    <!-- prettier-ignore -->
    <script type="module">${js}</script>
  </body>
</html>
`;

const outputPath = resolve(root, 'recover.html');

if (process.argv.includes('--check')) {
  let current;
  try {
    current = await readFile(outputPath, 'utf8');
  } catch {
    current = '';
  }
  if (current !== html) {
    process.stderr.write(
      'recover.html is stale. Run `pnpm --filter @ferry/web build:recover` and commit the result.\n',
    );
    process.exitCode = 1;
  } else {
    process.stdout.write('recover.html matches a fresh build.\n');
  }
} else {
  await writeFile(outputPath, html);
}
