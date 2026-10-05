// npm run dev:alert -w @penge/server -- --office 486 --date 2026-10-09
// Opens that date at that office in the running local stack's fake DFA, and has it
// run the real checker once, so subscribers there get a real alert and a tap on the
// notification finds the date open.
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { office: { type: 'string' }, date: { type: 'string' } } });
const res = await fetch('http://127.0.0.1:8787/dev/open', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ office: Number(values.office), date: values.date }),
});
process.stderr.write(`${res.status} ${await res.text()}\n`);
process.exitCode = res.ok ? 0 : 1;
