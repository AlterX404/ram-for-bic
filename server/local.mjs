import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { route } from './router.mjs';
import { openDatabase } from './sqlite.mjs';

const filename = resolve(process.env.COMMONROOM_DB || '.commonroom/data.sqlite');
const portArg = process.argv.indexOf('--port');
const port = Number((portArg >= 0 ? process.argv[portArg + 1] : undefined) || process.env.PORT || process.env.COMMONROOM_PORT || 4317);
await mkdir(dirname(filename), { recursive: true });
const binding = openDatabase(filename);

createServer(async (incoming, outgoing) => {
  try {
    const origin = 'http://' + (incoming.headers.host || '127.0.0.1:' + port);
    const request = new Request(new URL(incoming.url, origin), {
      method: incoming.method, headers: incoming.headers,
      ...(!['GET', 'HEAD'].includes(incoming.method) ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}),
    });
    const response = await route(request, binding, (file) => readFile(file, 'utf8'));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
    else outgoing.end();
  } catch (error) {
    console.error(error.message);
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end('Commonroom could not load this request.');
  }
}).listen(port, '127.0.0.1', () => console.log('Commonroom: http://127.0.0.1:' + port + '/commonroom/'));
