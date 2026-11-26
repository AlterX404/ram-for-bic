import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { files } from './router.mjs';

const sources = await Promise.all(['store.mjs', 'api.mjs', 'router.mjs'].map(async (file) => {
  const source = await readFile(new URL(file, import.meta.url), 'utf8');
  return source.replace(/^import .+ from '\.\/[a-z]+\.mjs';\r?\n/gm, '').replace(/^export /gm, '');
}));
const assets = Object.fromEntries(await Promise.all(Object.values(files).map(async ([file]) => [file, await readFile(file, 'utf8')])));
await mkdir('dist/server', { recursive: true });
await writeFile('dist/server/index.js', sources.join('\n') + '\nconst assets = ' + JSON.stringify(assets)
  + ';\nexport default { fetch(request, env) { return route(request, env.DB, (file) => assets[file]); } };\n');
console.log('Built Commonroom worker and embedded assets.');
