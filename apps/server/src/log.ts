// One JSON object per line on stdout; journald keeps them. Never log an email
// address, a token or a key: callers pass ids and counts only.
export type Fields = Record<string, unknown>;

export interface Logger {
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

function write(level: string, msg: string, fields: Fields = {}) {
  const extra = Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, v instanceof Error ? `${v.name}: ${v.message}` : v]),
  );
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra })}\n`);
}

export const log: Logger = {
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
};

export const silentLog: Logger = { info() {}, warn() {}, error() {} };
