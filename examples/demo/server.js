import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const port = Number(process.env.PROOFPATCH_DEMO_PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PROOFPATCH_DEMO_PORT must be an integer between 1 and 65535.');
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ProofPatch notes demo</title>
<link rel="icon" href="data:,"></head>
<body><h1>Notes</h1><form><label>Note <input name="note" required></label>
<button type="submit">Add</button></form><ul id="notes"></ul>
<script type="module">
import { normalizeNote } from '/notes.js';
document.querySelector('form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.querySelector('input');
  const text = normalizeNote(input.value);
  if (!text) return;
  const item = document.createElement('li');
  item.textContent = text;
  document.querySelector('#notes').append(item);
  input.value = '';
});
</script></body></html>`;

createServer(async (request, response) => {
  if (request.url === '/notes.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript' });
    response.end(await readFile(new URL('./notes.js', import.meta.url)));
  } else if (request.url === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
  } else {
    response.writeHead(404);
    response.end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Notes demo listening on http://127.0.0.1:${port}`));
