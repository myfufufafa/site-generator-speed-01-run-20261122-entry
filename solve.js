// Faster drop-in for makefun-site 1.0.0.
//
// Same answers, byte for byte, built the fast way: one fused pass over each
// source (front matter, Markdown and inline rendering without token objects
// or per-character escaping), a cached slugifier with an ASCII fast path, a
// template interpreter that inlines includes at parse time and reuses its
// loop scopes, and plain-run string building everywhere instead of
// string += per character. Standard library only, no state kept between
// cases: every cache is created fresh inside one run() call.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------- text

// Escape &, <, >, " and ' in s[a..b). Single pass; when nothing needs
// escaping the slice is returned untouched, so clean text costs one scan.
function escapeStr(s, a = 0, b = s.length) {
  let out = null;
  let start = a;
  for (let i = a; i < b; i++) {
    const ch = s[i];
    let e = null;
    if (ch === '&') e = '&amp;';
    else if (ch === '<') e = '&lt;';
    else if (ch === '>') e = '&gt;';
    else if (ch === '"') e = '&quot;';
    else if (ch === "'") e = '&#39;';
    if (e !== null) {
      if (out === null) out = '';
      if (i > start) out += s.slice(start, i);
      out += e;
      start = i + 1;
    }
  }
  if (out === null) return s.slice(a, b);
  if (b > start) out += s.slice(start, b);
  return out;
}

// Slug of text, cached per run. ASCII text (the overwhelming majority:
// titles, tags, headings) never touches normalize() or a regex: NFKD
// leaves ASCII unchanged and ASCII has no combining marks to drop.
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  if (out.length > 64) out = out.slice(0, 64);
  while (out.endsWith('-')) out = out.slice(0, -1);
  const slug = out === '' ? 'untitled' : out;
  cache.set(text, slug);
  return slug;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// "2026-11-09" -> "9 November 2026", from the string alone.
function longDate(date, cache) {
  const hit = cache.get(date);
  if (hit !== undefined) return hit;
  const s = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  cache.set(date, s);
  return s;
}

// Words of a body: runs of non-whitespace, counted by scanning instead of
// building an array of every word. The whitespace set is exactly JS \s:
// TAB LF VT FF CR SP NBSP and the Unicode spaces / line separators. The
// ASCII table makes the common case one array lookup per character.
const WS_TABLE = new Uint8Array(256);
for (const c of [9, 10, 11, 12, 13, 32, 160]) WS_TABLE[c] = 1;

function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c < 256) ws = WS_TABLE[c] === 1;
    else ws = c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
      c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (!ws) {
      if (!inWord) { n++; inWord = true; }
    } else inWord = false;
  }
  return n;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    // Fast path: no backslash and no quote before the closing one.
    if (raw.indexOf('\\') === -1 && raw.indexOf('"', 1) === raw.length - 1) return { value: raw.slice(1, -1) };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

// Front matter and body of a source, or { error }. The body is a slice of
// the source text, not a re-joined copy of its lines.
function parseFrontMatter(text) {
  const nl = text.indexOf('\n');
  if ((nl === -1 ? text : text.slice(0, nl)) !== '---') return { error: 'no front matter' };
  const fm = ['---'];
  let pos = nl === -1 ? text.length : nl + 1;
  let close = -1;
  while (pos < text.length) {
    const e = text.indexOf('\n', pos);
    const line = e === -1 ? text.slice(pos) : text.slice(pos, e);
    fm.push(line);
    if (line === '---') { close = fm.length - 1; pos = e === -1 ? text.length : e + 1; break; }
    pos = e === -1 ? text.length : e + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = fm[i];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(pos) };
}

// ---------------------------------------------------------------- Markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function isBlank(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  return (c === 32 || c === 9) && BLANK.test(line);
}

function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return BLANK.test(line);
  if (c === 96) return line.startsWith('```') && FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return HR.test(line);
  return false;
}

// Spaces and tabs at either end dropped (only those two characters).
function trimST(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

function findUnescaped(s, what, from, end) {
  for (let j = from; j + what.length <= end; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (j + 1 < end && s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

// Resolve a link target the way the reference does, for one source.
function linkTarget(ctx, target) {
  if (target.startsWith('/') || target.startsWith('#')) return target;
  const colon = target.indexOf(':');
  if (colon > 0) {
    let ok = (target.charCodeAt(0) >= 65 && target.charCodeAt(0) <= 90) || (target.charCodeAt(0) >= 97 && target.charCodeAt(0) <= 122);
    for (let i = 1; i < colon && ok; i++) {
      const c = target.charCodeAt(i);
      ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 45 || c === 46;
    }
    if (ok) return target;
  }
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  if (rel === '') {
    ctx.broken.add(`broken-link ${ctx.path} -> ${target}`);
    return target;
  }
  const parts = ctx.dirParts.slice();
  let start = 0;
  for (;;) {
    const idx = rel.indexOf('/', start);
    const seg = idx === -1 ? rel.slice(start) : rel.slice(start, idx);
    if (seg === '' || seg === '.') {
      // skip
    } else if (seg === '..') {
      if (parts.length === 0) {
        ctx.broken.add(`broken-link ${ctx.path} -> ${target}`);
        return target;
      }
      parts.pop();
    } else parts.push(seg);
    if (idx === -1) break;
    start = idx + 1;
  }
  const path = parts.join('/');
  const pg = ctx.bySource.get(path);
  if (pg !== undefined) return `${pg.url}${frag}`;
  if (ctx.staticPaths.has(path)) return `${ctx.base}/${path}${frag}`;
  ctx.broken.add(`broken-link ${ctx.path} -> ${target}`);
  return target;
}

// Char codes that start an inline construct or need escaping; every other
// ASCII character is plain text and skips the whole dispatch chain.
const SPECIAL_TABLE = new Uint8Array(128);
for (const c of [92, 96, 42, 91, 38, 60, 62, 34, 39]) SPECIAL_TABLE[c] = 1;

// Inline rendering of s[a..b) into out, without slicing the string for
// nested strong / emphasis / link text: the recursion works on bounds.
function inlineTo(out, s, a, b, ctx) {
  let i = a;
  let plain = a;
  while (i < b) {
    const c = s[i];
    if (c.charCodeAt(0) >= 128 || SPECIAL_TABLE[c.charCodeAt(0)] === 0) { i++; continue; }
    if (c === '\\' && i + 1 < b && ESCAPABLE.has(s[i + 1])) {
      if (i > plain) out.push(s.slice(plain, i));
      const n = s[i + 1];
      out.push(n === '>' ? '&gt;' : n);
      i += 2;
      plain = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        if (i > plain) out.push(s.slice(plain, i));
        out.push('<code>', escapeStr(s, i + 1, j), '</code>');
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (i + 1 < b && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, b);
        if (j > i + 2) {
          if (i > plain) out.push(s.slice(plain, i));
          out.push('<strong>');
          inlineTo(out, s, i + 2, j, ctx);
          out.push('</strong>');
          i = j + 2;
          plain = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, b);
      if (j > i + 1) {
        if (i > plain) out.push(s.slice(plain, i));
        out.push('<em>');
        inlineTo(out, s, i + 1, j, ctx);
        out.push('</em>');
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, b);
      const m = k !== -1 && k + 1 < b && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (m !== -1 && m < b && target !== '' && !/\s/.test(target)) {
        if (i > plain) out.push(s.slice(plain, i));
        out.push('<a href="', escapeStr(linkTarget(ctx, target)), '">');
        inlineTo(out, s, i + 1, k, ctx);
        out.push('</a>');
        i = m + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === '&') { if (i > plain) out.push(s.slice(plain, i)); out.push('&amp;'); i++; plain = i; continue; }
    if (c === '<') { if (i > plain) out.push(s.slice(plain, i)); out.push('&lt;'); i++; plain = i; continue; }
    if (c === '>') { if (i > plain) out.push(s.slice(plain, i)); out.push('&gt;'); i++; plain = i; continue; }
    if (c === '"') { if (i > plain) out.push(s.slice(plain, i)); out.push('&quot;'); i++; plain = i; continue; }
    if (c === "'") { if (i > plain) out.push(s.slice(plain, i)); out.push('&#39;'); i++; plain = i; continue; }
    i++;
  }
  if (b > plain) out.push(s.slice(plain, b));
}

function inlineStr(s, ctx) {
  const out = [];
  inlineTo(out, s, 0, s.length, ctx);
  return out.join('');
}

// One body rendered, in a single pass over its lines: no token objects,
// no second walk. Returns { html, toc, excerpt }.
function renderMarkdown(src, ctx, slugCache) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const c0 = line.charCodeAt(0);
    if (c0 === 96 && line.startsWith('```')) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const lang = fence[1];
        const body = [];
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (l.startsWith('```') && FENCE_CLOSE.test(l)) break;
          body.push(l);
          i++;
        }
        i++;
        const parts = ['<pre><code'];
        if (lang !== '') { parts.push(' class="language-', escapeStr(lang), '"'); }
        parts.push('>');
        for (const l of body) { parts.push(escapeStr(l), '\n'); }
        parts.push('</code></pre>');
        blocks.push(parts.join(''));
        continue;
      }
    }
    if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text, slugCache), ids);
        const html = inlineStr(h.text, ctx);
        blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    }
    if (c0 === 45 || c0 === 42) {
      if (HR.test(line)) { blocks.push('<hr>'); i++; continue; }
    }
    if (c0 === 62) {
      const q = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        q.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const body = [];
      for (const l of q) {
        const t = trimST(l);
        if (t !== '') body.push(t);
      }
      blocks.push(body.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(body.join('\n'), ctx)}</p>\n</blockquote>`);
      continue;
    }
    let bullet = null;
    let ordered = null;
    if ((c0 === 45 || c0 === 42) && line.length > 1 && line.charCodeAt(1) === 32) bullet = BULLET.exec(line);
    else if (c0 >= 48 && c0 <= 57) ordered = ORDERED.exec(line);
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const start = isOrdered ? Number(ordered[1]) : 1;
      const items = [];
      while (i < lines.length) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimST(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (lines[i].length >= 3 && lines[i].charCodeAt(0) === 32 && lines[i].charCodeAt(1) === 32 && CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimST(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const parts = [isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`, '\n'];
      for (const parts2 of items) parts.push('<li>', inlineStr(parts2.join('\n'), ctx), '</li>\n');
      parts.push(`</${tag}>`);
      blocks.push(parts.join(''));
      continue;
    }
    const body = [trimST(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimST(lines[i++]));
    const html = inlineStr(body.join('\n'), ctx);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((x) => `${x}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// Inline every include statically (depth-capped at 8, exactly the runtime
// rule), so a page render never pays a call per include and a card inside
// a loop never pays one per iteration. Falls back to dynamic includes when
// the expansion would explode.
function expandNodes(nodes, templates, depth, counter) {
  const out = [];
  for (const n of nodes) {
    if (n.kind === 'include') {
      if (depth >= 8) continue;
      const child = templates.get(n.name);
      if (child === undefined) continue;
      counter.count += child.length;
      if (counter.count > 20000) return null;
      const exp = expandNodes(child, templates, depth + 1, counter);
      if (exp === null) return null;
      for (const x of exp) out.push(x);
    } else if (n.kind === 'for') {
      const body = expandNodes(n.body, templates, depth, counter);
      if (body === null) return null;
      out.push({ kind: 'for', name: n.name, path: n.path, body });
    } else if (n.kind === 'if') {
      const thenB = expandNodes(n.then, templates, depth, counter);
      if (thenB === null) return null;
      const elseB = n.else === null ? null : expandNodes(n.else, templates, depth, counter);
      if (n.else !== null && elseB === null) return null;
      out.push({ kind: 'if', not: n.not, path: n.path, then: thenB, else: elseB });
    } else out.push(n);
  }
  return out;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, ctx, depth) {
  const out = [];
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeStr(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out.push(renderNodes(branch, scope, ctx, depth));
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        // One scope object and one loop object per execution, mutated per
        // iteration: rendering is synchronous and nothing retains them.
        const vars = {};
        const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
        vars[n.name] = xs[0];
        vars.loop = loop;
        const child = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          out.push(renderNodes(n.body, child, ctx, depth));
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < 8) out.push(renderNodes(t, scope, ctx, depth + 1));
        break;
      }
    }
  }
  return out.join('');
}

// ---------------------------------------------------------------- template compilation

// Names a loop variable may not take in generated code: reserved words,
// the generated function's own parameters, the per-loop scratch names,
// and anything that would collide with the `loop` binding.
const CODEGEN_DENY = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'enum', 'await',
  'implements', 'package', 'protected', 'interface', 'private', 'public', 'arguments', 'eval',
  'undefined', 'NaN', 'Infinity', 'globalThis', 'vars', 'out', 'escapeStr', 'textOf', 'truthy',
  'loop', 'Array', 'Object', 'JSON', 'String', 'Number', 'Boolean', 'Math', 'console',
  'process', 'require', 'module', 'exports', '__proto__', 'constructor', 'prototype',
]);

// Compile an (already include-expanded) template into one function
// (vars, out, escapeStr, textOf, truthy) that renders it with native
// loops and conditionals. Loop variables become lexical JS variables, so
// a path starting with one reads it directly and a path starting with
// anything else reads the null-prototype vars object. Returns null when
// the template cannot be compiled safely; the caller then interprets it.
function compileTemplate(nodes) {
  let counter = 0;
  const gen = (ns, scope) => {
    let code = '';
    for (const n of ns) {
      if (n.kind === 'text') code += `out.push(${JSON.stringify(n.text)});`;
      else if (n.kind === 'var' || n.kind === 'raw') {
        const expr = pathExpr(n.path, scope);
        if (expr === null) return null;
        code += n.kind === 'var'
          ? `out.push(escapeStr(textOf(${expr})));`
          : `out.push(textOf(${expr}));`;
      } else if (n.kind === 'if') {
        const expr = pathExpr(n.path, scope);
        if (expr === null) return null;
        const thenCode = gen(n.then, scope);
        if (thenCode === null) return null;
        const cond = n.not ? `!truthy(${expr})` : `truthy(${expr})`;
        code += `if(${cond}){${thenCode}}`;
        if (n.else !== null) {
          const elseCode = gen(n.else, scope);
          if (elseCode === null) return null;
          code += `else{${elseCode}}`;
        }
      } else if (n.kind === 'for') {
        if (CODEGEN_DENY.has(n.name) || n.name.startsWith('__')) return null;
        const expr = pathExpr(n.path, scope);
        if (expr === null) return null;
        const id = ++counter;
        const body = gen(n.body, [...scope, n.name, 'loop']);
        if (body === null) return null;
        code += `{const __x${id}=${expr};if(Array.isArray(__x${id})){const loop={index:0,first:false,last:false,length:__x${id}.length};for(let __k${id}=0;__k${id}<__x${id}.length;__k${id}++){const ${n.name}=__x${id}[__k${id}];loop.index=__k${id}+1;loop.first=__k${id}===0;loop.last=__k${id}===__x${id}.length-1;${body}}}}`;
      } else return null; // include: only the interpreter handles it
    }
    return code;
  };
  const pathExpr = (path, scope) => {
    // A first segment bound by an enclosing loop is a lexical variable;
    // anything else is a property of the null-prototype vars object.
    let expr;
    if (scope.includes(path[0])) expr = path[0];
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(path[0])) expr = `vars.${path[0]}`;
    else return null;
    for (let k = 1; k < path.length; k++) expr += `?.${path[k]}`;
    return expr;
  };
  try {
    const code = gen(nodes, []);
    if (code === null) return null;
    return new Function('vars', 'out', 'escapeStr', 'textOf', 'truthy', code);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------- build

export function run(input) {
  const slugCache = new Map();
  const dateCache = new Map();
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Expand includes once per template, after all of them parsed.
  for (const [name, nodes] of templates) {
    const counter = { count: nodes.length };
    const exp = expandNodes(nodes, templates, 0, counter);
    if (exp !== null) templates.set(name, exp);
  }

  let base = input.site.base_url;
  while (base.endsWith('/')) base = base.slice(0, -1);

  // 1. Sources, sorted by path; \r\n / \r made \n only when present.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in the reference's check order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const ctx = {
      path: s.path, base, bySource, staticPaths, broken,
      dirParts: dir === '' ? [] : dir.split('/'),
    };
    const md = renderMarkdown(s.body, ctx, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, slugCache);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, once per source; the posts' cards are the ones lists use.
  const cards = new Map();
  for (const s of kept) {
    const card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s.card = card;
    if (s.post) cards.set(s, card);
  }
  const linkOf = (s) => (s === null ? null : {
    title: s.data.title, url: s.url, date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache),
  });

  // 7. Layouts.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const tctx = { templates, escape: escapeStr };
  const compiled = new Map();
  for (const [name, nodes] of templates) {
    const fn = compileTemplate(nodes);
    if (fn !== null) compiled.set(name, fn);
  }
  const render = (name, vars) => {
    const fn = compiled.get(name);
    if (fn !== undefined) {
      const v = Object.create(null);
      v.site = site;
      v.tags = allTags;
      v.recent = recent;
      Object.assign(v, vars);
      const out = [];
      fn(v, out, escapeStr, textOf, truthy);
      return out.join('');
    }
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    return renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, tctx, 0);
  };
  for (const s of kept) {
    const c = s.card;
    const page = {
      title: c.title, url: c.url, date: c.date, date_long: c.date_long,
      summary: c.summary, excerpt: c.excerpt, reading_minutes: c.reading_minutes, tags: c.tags,
      slug: s.slug, content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null), older: linkOf(s.older ?? null), is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
