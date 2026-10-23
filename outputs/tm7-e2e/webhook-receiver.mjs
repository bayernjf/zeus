// Minimal local webhook receiver for agent-world notify nodes (after-sales).
// Records POST bodies to a log file and always answers 200.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const LOG = process.argv[2] ?? '/tmp/tm7-webhook.log';
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    appendFileSync(LOG, `${new Date().toISOString()} ${req.method} ${req.url} ${body}\n`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
});
server.listen(3029, '127.0.0.1', () => console.log('webhook receiver on 3029'));
