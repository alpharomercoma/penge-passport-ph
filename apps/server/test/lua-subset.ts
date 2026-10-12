// Valkey runs Lua 5.1; the tests run Lua 5.4. This keeps scripts to what both run the same way.
const RULES: [string, RegExp][] = [
  ['//', /\/\//],
  ['goto', /\bgoto\b/],
  ['::label::', /::\w+::/],
  ['bitwise operator', /[&|]|<<|>>|~(?!=)/],
  ['table.unpack', /\btable\.unpack\b/],
  ['utf8', /\butf8\./],
  ['math.pow', /\bmath\.(pow|tointeger|type|ult)\b/],
  ['attribute', /<\s*(const|close)\s*>/],
  ['string.pack', /\bstring\.(pack|unpack|packsize)\b/],
  ['table.move', /\btable\.move\b/],
  ['loadstring/setfenv', /\b(loadstring|setfenv|getfenv|load)\s*\(/],
  // Valkey protects its tables and metatables; the test engine cannot fully, so scripts never reach for them.
  ['raw access/metatable', /\b(rawset|rawget|rawequal|setmetatable|getmetatable)\s*\(/],
];

/** The source with comments and string literals blanked out, so their contents are never mistaken for code. */
function codeOnly(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const long = /^(--)?\[(=*)\[/.exec(rest);
    if (long) {
      const close = `]${long[2]}]`;
      const end = source.indexOf(close, i + long[0].length);
      i = end < 0 ? source.length : end + close.length;
      out += ' ';
      continue;
    }
    if (rest.startsWith('--')) {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
      continue;
    }
    const q = source[i];
    if (q === '"' || q === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== q) j += source[j] === '\\' ? 2 : 1;
      i = j + 1;
      out += '""';
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

/** Whether a quoted string uses an escape Lua 5.1 does not have (\x.., \z, \u{..}): 5.1 reads them differently. */
function newEscapes(source: string): boolean {
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const long = /^(--)?\[(=*)\[/.exec(rest);
    if (long) {
      const end = source.indexOf(`]${long[2]}]`, i + long[0].length);
      i = end < 0 ? source.length : end + long[2]!.length + 2;
      continue;
    }
    if (rest.startsWith('--')) {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
      continue;
    }
    const q = source[i];
    if (q === '"' || q === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== q) {
        if (source[j] === '\\') {
          if ('xzu'.includes(source[j + 1] ?? '')) return true;
          j += 2;
        } else j += 1;
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return false;
}

export function lintLua51(source: string): string[] {
  if (!source.startsWith('#!lua')) return ['no #!lua shebang'];
  const body = source.slice(source.indexOf('\n') + 1);
  const code = codeOnly(body);
  const found = RULES.filter(([, re]) => re.test(code)).map(([name]) => name);
  return newEscapes(body) ? [...found, 'escape'] : found;
}
