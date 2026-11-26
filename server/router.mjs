import { handleApi } from './api.mjs';

export const files = {
  '/': ['dist/index.html', 'text/html; charset=utf-8'],
  '/commonroom/': ['dist/commonroom/index.html', 'text/html; charset=utf-8'],
  '/commonroom/app.js': ['dist/commonroom/app.js', 'text/javascript; charset=utf-8'],
  '/commonroom/client.js': ['dist/commonroom/client.js', 'text/javascript; charset=utf-8'],
  '/commonroom/ui.js': ['dist/commonroom/ui.js', 'text/javascript; charset=utf-8'],
  '/commonroom/threads.js': ['dist/commonroom/threads.js', 'text/javascript; charset=utf-8'],
  '/commonroom/threads.css': ['dist/commonroom/threads.css', 'text/css; charset=utf-8'],
  '/commonroom/style.css': ['dist/commonroom/style.css', 'text/css; charset=utf-8'],
};

export async function route(request, binding, load) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return handleApi(request, binding);
  if (url.pathname === '/commonroom') return Response.redirect(new URL('/commonroom/' + url.search, url), 308);
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
  const asset = Object.hasOwn(files, url.pathname) && files[url.pathname];
  if (!asset) return new Response('Page not found', { status: 404 });
  const content = request.method === 'GET' ? await load(asset[0]) : null;
  const campaign = url.pathname === '/';
  return new Response(content, { headers: {
    'Content-Type': asset[1],
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'" + (campaign ? " 'unsafe-inline'" : '')
      + "; style-src 'self' 'unsafe-inline'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'; form-action 'self'",
  } });
}
