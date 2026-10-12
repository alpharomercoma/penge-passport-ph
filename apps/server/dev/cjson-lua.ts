// Valkey's scripts have a built-in cjson; Lua in tests gets this stand-in. Numbers encode as %.14g, as cjson does.
export const CJSON_LUA = String.raw`
cjson = {}
local function esc(s)
  return (s:gsub('[%c"\\]', function(c)
    local m = { ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
    return m[c] or string.format('\\u%04x', string.byte(c))
  end))
end
-- As cjson (encode_sparse_array false, ratio 2, safe 10): a table whose keys are all positive integers is an array of
-- its largest key's length, gaps as null, unless it is "excessively sparse" (largest key > 10 and > twice the count).
local function arraylength(t)
  local n, max = 0, 0
  for k in pairs(t) do
    if type(k) ~= 'number' or k < 1 or math.floor(k) ~= k then return nil end
    n = n + 1
    if k > max then max = k end
  end
  if max == 0 then return nil end
  if max > 10 and max > 2 * n then error('Cannot serialise table: excessively sparse array') end
  return max
end
-- Valkey's cjson decodes JSON null to the sentinel cjson.null, not nil: the stand-in does the same.
cjson.null = setmetatable({}, { __tostring = function() return 'null' end })
function cjson.encode(v)
  if v == nil or v == cjson.null then return 'null' end
  local t = type(v)
  if t == 'string' then return '"' .. esc(v) .. '"' end
  if t == 'number' then
    if v ~= v or v == math.huge or v == -math.huge then error('Cannot serialise number: must not be NaN or Infinity') end
    return string.format('%.14g', v)
  end
  if t == 'boolean' then return tostring(v) end
  if t == 'table' then
    local out = {}
    local n = arraylength(v)
    if n then
      for i = 1, n do out[i] = cjson.encode(v[i]) end
      return '[' .. table.concat(out, ',') .. ']'
    end
    local keys = {}
    for k in pairs(v) do
      local kt = type(k)
      if kt ~= 'string' and kt ~= 'number' then error('Cannot serialise ' .. kt .. ': table key must be a number or string') end
      keys[#keys + 1] = k
    end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    for i, k in ipairs(keys) do out[i] = '"' .. esc(tostring(k)) .. '":' .. cjson.encode(v[k]) end
    return '{' .. table.concat(out, ',') .. '}'
  end
  error('cjson stand-in cannot encode ' .. t)
end
function cjson.decode(s)
  local i = 1
  local function ws() i = s:find('[^ \t\r\n]', i) or #s + 1 end
  local value
  local function bad() error('cjson stand-in: bad JSON at ' .. i) end
  local function str()
    if s:sub(i, i) ~= '"' then bad() end
    local out = {}
    i = i + 1
    while true do
      local c = s:sub(i, i)
      if c == '"' then i = i + 1 return table.concat(out) end
      if c == '\\' then
        local e = s:sub(i + 1, i + 1)
        local m = { b = '\b', f = '\f', n = '\n', r = '\r', t = '\t', ['"'] = '"', ['\\'] = '\\', ['/'] = '/' }
        if e == 'u' then
          local function hex4(at)
            local h = s:sub(at, at + 3)
            if not h:match('^%x%x%x%x$') then bad() end
            return tonumber(h, 16)
          end
          local code = hex4(i + 2)
          i = i + 6
          -- As cjson: a high surrogate must be followed by \u and a low one (one 4-byte character); a lone one is an error.
          if code >= 0xDC00 and code <= 0xDFFF then bad() end
          if code >= 0xD800 and code <= 0xDBFF then
            if s:sub(i, i + 1) ~= '\\u' then bad() end
            local low = hex4(i + 2)
            if low < 0xDC00 or low > 0xDFFF then bad() end
            code = 0x10000 + (code - 0xD800) * 0x400 + (low - 0xDC00)
            i = i + 6
          end
          if code < 128 then out[#out + 1] = string.char(code)
          elseif code < 2048 then out[#out + 1] = string.char(192 + math.floor(code / 64), 128 + code % 64)
          elseif code < 65536 then out[#out + 1] = string.char(224 + math.floor(code / 4096), 128 + math.floor(code / 64) % 64, 128 + code % 64)
          else out[#out + 1] = string.char(240 + math.floor(code / 262144), 128 + math.floor(code / 4096) % 64, 128 + math.floor(code / 64) % 64, 128 + code % 64) end
        else
          if not m[e] then bad() end
          out[#out + 1] = m[e]
          i = i + 2
        end
      elseif c == '' then error('unterminated string')
      else out[#out + 1] = c i = i + 1 end
    end
  end
  function value()
    ws()
    local c = s:sub(i, i)
    if c == '{' then
      local t = {}
      i = i + 1 ws()
      if s:sub(i, i) == '}' then i = i + 1 return t end
      while true do
        ws() local k = str() ws()
        if s:sub(i, i) ~= ':' then bad() end
        i = i + 1
        t[k] = value() ws()
        local d = s:sub(i, i) i = i + 1
        if d == '}' then return t end
        if d ~= ',' then bad() end
      end
    elseif c == '[' then
      local t = {}
      i = i + 1 ws()
      if s:sub(i, i) == ']' then i = i + 1 return t end
      while true do
        t[#t + 1] = value() ws()
        local d = s:sub(i, i) i = i + 1
        if d == ']' then return t end
        if d ~= ',' then bad() end
      end
    elseif c == '"' then return str()
    elseif s:sub(i, i + 3) == 'true' then i = i + 4 return true
    elseif s:sub(i, i + 4) == 'false' then i = i + 5 return false
    elseif s:sub(i, i + 3) == 'null' then i = i + 4 return cjson.null
    else
      local num = s:match('^-?%d+%.?%d*[eE]?[-+]?%d*', i)
      if not num or num == '' or not tonumber(num) then bad() end
      i = i + #num
      return tonumber(num)
    end
  end
  local v = value()
  ws()
  if i <= #s then error('cjson stand-in: trailing characters at ' .. i) end
  return v
end
`;
