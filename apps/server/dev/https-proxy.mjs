// Local HTTPS for the debug Android app (it only opens https://). A self-signed
// certificate for localhost, made by scripts/local-stack.sh, kept in .local/tls/.
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:https';

const tls = { key: readFileSync('.local/tls/key.pem'), cert: readFileSync('.local/tls/cert.pem') };
createServer(tls, (req, res) => {
  const upstream = request({ host: '127.0.0.1', port: 4173, path: req.url, method: req.method, headers: { ...req.headers, host: 'localhost:4173' } }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', () => {
    res.writeHead(502);
    res.end('the local site is not running');
  });
  req.pipe(upstream);
}).listen(8443, '127.0.0.1', () => console.log('https://localhost:8443/pengepassportph/'));
