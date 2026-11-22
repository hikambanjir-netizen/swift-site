// swift-site: a fast drop-in for makefun-site 1.0.0.
// run(input) returns exactly the output tree makefun-site's build returns for
// the same input: a JSON object of every path it writes and that file's text,
// byte for byte. Written from the makefun-site README and its reference
// behaviour, reimplemented for speed: bulk escaping, a char-code Markdown
// scanner, memoised slugs and templates compiled to plain functions.
// Pure Node 22 standard library, deterministic, no network, no model calls.

const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';
const SLUG_MAX = 64;

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------------------------------------------ text */

// The HTML escape table: & < > " ' and nothing else.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_ALL = /[&<>"']/g;

/** `text` with & < > " and ' escaped. A replace with no match returns the
 * string itself, so one scan and no copy when it holds none of them. */
function escapeHtml(text) {
  return text.replace(ESCAPE_ALL, (c) => ESCAPES[c]);
}

/** Slug memo: titles, tag names and headings repeat across a site. */
const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 * Pure-ASCII input normalises to itself and holds no combining marks, so it
 * takes a single char-code pass with no normalise or regex work.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out = '';
  let ascii = true;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  if (ascii) {
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        if (out.length > 0) gap = true;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        if (out.length > 0) gap = true;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
const longDateCache = new Map();
function longDate(date) {
  let hit = longDateCache.get(date);
  if (hit === undefined) {
    const [y, m, d] = date.split('-');
    hit = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
    longDateCache.set(date, hit);
  }
  return hit;
}

/* ------------------------------------------------------------ front matter */

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function fmDaysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function fmStringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
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
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmStringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > fmDaysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    let raw = m[2] ?? '';
    let e = raw.length;
    while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
    raw = raw.slice(0, e);
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

/* --------------------------------------------------------------- markdown */

// Block scanning works on char codes, not a regex per line: a body holds
// hundreds of lines and the lexer runs once per source.

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** A list continuation: two or more spaces, then a non-space. */
const CONTINUED = /^ {2,}\S/;

/** A fence-open line's language, or null when the line is no fence open. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let j = n;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let e = line.length;
  while (e > j && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === j) return null;
  return { depth: n, text: line.slice(j, e) };
}

function isHr(line) {
  if (line.length < 3) return false;
  const a = line.charCodeAt(0);
  if (a !== 45 && a !== 42) return false;
  if (line.charCodeAt(1) !== a || line.charCodeAt(2) !== a) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/**
 * `src`'s block tokens, in order. Token shapes: heading {depth, text}, code
 * {lang, lines}, hr, blockquote {lines}, list {ordered, start, items},
 * paragraph {text}.
 */
function lexBlocks(src) {
  const lines = src.split('\n');
  const tokens = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      tokens.push({ type: 'code', lang, lines: body });
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      tokens.push({ type: 'heading', depth: heading.depth, text: heading.text });
      i++;
      continue;
    }
    if (isHr(line)) {
      tokens.push({ type: 'hr' });
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let s = lines[i++];
        s = s.slice(1);
        if (s.charCodeAt(0) === 32) s = s.slice(1);
        body.push(s);
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      tokens.push({ type: 'blockquote', lines: kept });
      continue;
    }
    // A list: "- "/"* " bullets or "digits. " ordered; two-plus-space lines
    // continue the last item. No nesting.
    let isOrdered = false;
    let start = 1;
    let firstText = null;
    if (line.length >= 2 && (line.charCodeAt(0) === 45 || line.charCodeAt(0) === 42) && line.charCodeAt(1) === 32) {
      firstText = line.slice(2);
    } else {
      const dot = line.indexOf('. ');
      if (dot > 0 && dot <= 9) {
        let ok = true;
        for (let k = 0; k < dot; k++) {
          const c = line.charCodeAt(k);
          if (c < 48 || c > 57) { ok = false; break; }
        }
        if (ok) { isOrdered = true; start = Number(line.slice(0, dot)); firstText = line.slice(dot + 2); }
      }
    }
    if (firstText !== null) {
      const items = [[trimLine(firstText)]];
      i++;
      while (i < n) {
        const l = lines[i];
        let m = null;
        if (l.length >= 2 && (l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
          if (!isOrdered) m = l.slice(2);
        } else if (isOrdered) {
          const d2 = l.indexOf('. ');
          if (d2 > 0 && d2 <= 9) {
            let ok = true;
            for (let k = 0; k < d2; k++) {
              const c = l.charCodeAt(k);
              if (c < 48 || c > 57) { ok = false; break; }
            }
            if (ok) m = l.slice(d2 + 2);
          }
        }
        if (m !== null) {
          items.push([trimLine(m)]);
          i++;
        } else if (CONTINUED.test(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      tokens.push({ type: 'list', ordered: isOrdered, start, items: items.map((parts) => parts.join('\n')) });
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

/* ------------------------------------------------------------ inline */

// The characters a backslash escapes.
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const HAS_WS = /\s/;

/**
 * The first index from `from` where `s` holds `what` outside a backslash
 * escape, or -1. indexOf jumps between candidates; a backslash before a
 * candidate is walked the way the reference walk would.
 */
function findUnescaped(s, what, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf(what, j);
    if (k === -1) return -1;
    const b = s.indexOf('\\', j);
    if (b === -1 || b >= k) return k;
    if (b + 1 < s.length && ESCAPABLE.has(s[b + 1])) j = b + 2;
    else j = b + 1;
  }
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf('*', j);
    if (k === -1) return -1;
    const b = s.indexOf('\\', j);
    if (b !== -1 && b < k) {
      if (b + 1 < s.length && ESCAPABLE.has(s[b + 1])) j = b + 2;
      else j = b + 1;
      continue;
    }
    if (s[k + 1] === '*') { j = k + 2; continue; }
    return k;
  }
}

/**
 * `s` rendered inline into `out` (an array of string chunks);
 * `env.link(target)` is a link's href. A regex jumps from one special
 * character (`\`, backtick, `*`, `[`) to the next, so plain text is never
 * walked a character at a time; each plain run is escaped in bulk.
 * (The shared regex's lastIndex is set before every exec, so the recursion
 * for strong, emphasis and link text cannot disturb the outer scan.)
 */
const INLINE_SPECIAL = /[\\`*\[]/g;
function inlineInto(s, env, out) {
  let i = 0;
  let plain = 0;
  const n = s.length;
  const flush = (to) => {
    if (to > plain) out.push(escapeHtml(s.slice(plain, to)));
  };
  for (;;) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    if (m === null) break;
    const p = m.index;
    const c = s.charCodeAt(p);
    if (c === 92) {
      const d = s[p + 1];
      if (d !== undefined && ESCAPABLE.has(d)) {
        flush(p);
        out.push(escapeHtml(d));
        i = p + 2;
        plain = i;
      } else i = p + 1;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', p + 1);
      if (j > p + 1) {
        flush(p);
        out.push('<code>', escapeHtml(s.slice(p + 1, j)), '</code>');
        i = j + 1;
        plain = i;
      } else i = p + 1;
      continue;
    }
    if (c === 42) {
      if (s[p + 1] === '*') {
        const j = findUnescaped(s, '**', p + 2);
        if (j > p + 2) {
          flush(p);
          out.push('<strong>');
          inlineInto(s.slice(p + 2, j), env, out);
          out.push('</strong>');
          i = j + 2;
          plain = i;
        } else i = p + 2;
        continue;
      }
      const j = findSingleStar(s, p + 1);
      if (j > p + 1) {
        flush(p);
        out.push('<em>');
        inlineInto(s.slice(p + 1, j), env, out);
        out.push('</em>');
        i = j + 1;
        plain = i;
      } else i = p + 1;
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', p + 1);
      const m2 = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 ? '' : s.slice(k + 2, m2);
      if (target !== '' && !HAS_WS.test(target)) {
        flush(p);
        out.push('<a href="', escapeHtml(env.link(target)), '">');
        inlineInto(s.slice(p + 1, k), env, out);
        out.push('</a>');
        i = m2 + 1;
        plain = i;
        continue;
      }
      i = p + 1;
      continue;
    }
    i = p + 1;
  }
  flush(n);
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and
 * its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * Blocks are pushed as chunks into one array and joined once; a heading's
 * or the first paragraph's HTML is taken from the chunk slice it spans.
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  for (const t of lexBlocks(src)) {
    if (t.type === 'heading') {
      const id = uniqueSlug(slugify(t.text), ids);
      out.push(`<h${t.depth} id="${id}">`);
      const mark = out.length;
      inlineInto(t.text, env, out);
      out.push(`</h${t.depth}>`, '\n');
      if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html: out.slice(mark, out.length - 2).join('') });
    } else if (t.type === 'code') {
      const cls = t.lang === '' ? '' : ` class="language-${escapeHtml(t.lang)}"`;
      // Escaping is per character and '\n' passes through, so escaping the
      // whole body at once is the same as escaping each line separately.
      out.push(`<pre><code${cls}>`, escapeHtml(t.lines.length === 0 ? '' : `${t.lines.join('\n')}\n`), '</code></pre>', '\n');
    } else if (t.type === 'hr') {
      out.push('<hr>', '\n');
    } else if (t.type === 'blockquote') {
      if (t.lines.length === 0) out.push('<blockquote>\n</blockquote>', '\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineInto(t.lines.join('\n'), env, out);
        out.push('</p>\n</blockquote>', '\n');
      }
    } else if (t.type === 'list') {
      const tag = t.ordered ? 'ol' : 'ul';
      out.push(t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`, '\n');
      for (const item of t.items) {
        out.push('<li>');
        inlineInto(item, env, out);
        out.push('</li>', '\n');
      }
      out.push(`</${tag}>`, '\n');
    } else {
      out.push('<p>');
      const mark = out.length;
      inlineInto(t.text, env, out);
      out.push('</p>', '\n');
      if (excerpt === null) excerpt = out.slice(mark, out.length - 2).join('');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

/* -------------------------------------------------------------- templates */

// makefun-site's template dialect: {{ path }} escaped, {{{ path }}} raw,
// {% for x in path %} ... {% endfor %}, {% if [not] path %} ... {% else %}
// ... {% endif %}, {% include "name" %}. A {% %} tag alone on its line takes
// the whole line with it, its newline included. A template does not parse
// when a {{, {{{ or {% is not closed, a path is not one, a tag is none of
// the above, or a for or if is not closed or closed out of order.

const INCLUDE_DEPTH = 8;
const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function tplPathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tplTokenize(name, src) {
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
      tokens.push({ t: raw ? 'raw' : 'var', path: tplPathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
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

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tplTokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: tplPathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: tplPathOf(name, m[2]), then: [], else: null };
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
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function tplLookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function tplTextOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(tplTextOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function tplTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * A parsed template compiled to a function (scope, depth) => string. The
 * compiled code walks no node tree: text is pushed literally, values are
 * looked up and written, loops and branches are plain JavaScript. Includes
 * call back through `renderCompiled` with the same scope and depth + 1.
 */
function compileTemplate(nodes) {
  const src = [];
  src.push('var O=[];');
  let seq = 0;
  const emit = (nodes, depth) => {
    const S = `S${depth}`;
    for (const n of nodes) {
      if (n.kind === 'text') src.push(`O.push(${JSON.stringify(n.text)});`);
      else if (n.kind === 'var') src.push(`O.push(E(T(L(${S},${JSON.stringify(n.path)}))));`);
      else if (n.kind === 'raw') src.push(`O.push(T(L(${S},${JSON.stringify(n.path)})));`);
      else if (n.kind === 'if') {
        src.push(`if(TR(L(${S},${JSON.stringify(n.path)}))!==${n.not}){`);
        emit(n.then, depth);
        if (n.else !== null) {
          src.push('}else{');
          emit(n.else, depth);
        }
        src.push('}');
      } else if (n.kind === 'for') {
        const id = seq++;
        const A = `A${id}`;
        const K = `K${id}`;
        const NS = `S${depth + 1}`;
        src.push(`var ${A}=L(${S},${JSON.stringify(n.path)});`);
        src.push(`if(Array.isArray(${A})){for(var ${K}=0;${K}<${A}.length;${K}++){var ${NS}={vars:{[${JSON.stringify(n.name)}]:${A}[${K}],loop:{index:${K}+1,first:${K}===0,last:${K}===${A}.length-1,length:${A}.length}},parent:${S}};`);
        emit(n.body, depth + 1);
        src.push('}}');
      } else if (n.kind === 'include') {
        src.push(`O.push(IN(${JSON.stringify(n.name)},${S},D));`);
      }
    }
  };
  emit(nodes, 0);
  src.push('return O.join("");');
  return new Function('L', 'T', 'E', 'TR', 'IN', 'S0', 'D', src.join('\n'));
}

/**
 * Render a compiled template by name in `scope` at `depth`, or "" when it is
 * missing. `IN` is the case's shared include helper: an include inside the
 * template renders at depth + 1, and one nested more than 8 deep renders
 * nothing, the depth check sitting at the include site.
 */
function renderCompiled(compiled, name, scope, depth, IN) {
  const fn = compiled.get(name);
  if (fn === undefined) return '';
  return fn(tplLookup, tplTextOf, escapeHtml, tplTruthy, IN, scope, depth);
}

/* ------------------------------------------------------------------ build */

/** The words of a body: its runs of characters other than whitespace.
 * Counted in one char-code pass over a 128-entry whitespace table (plus
 * the Unicode spaces above it): whitespace is exactly JavaScript's \s. */
const WS_TABLE = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) WS_TABLE[c] = 1;
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c < 128 ? WS_TABLE[c] === 1 : (c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF);
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/** Whether `target` opens on a scheme (`https:`, `mailto:` ...): a letter,
 * then scheme characters, then a colon. Checked by char codes, no regex. */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function run(input) {
  // Templates, parsed and compiled in code-unit order of their name. One
  // that does not parse is reported and left out, as if it were not there.
  const compiled = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      compiled.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};
  const broken = new Set();

  // 1. Sources, in code-unit order of their paths; .md is a source, the
  // rest static. Line ends made "\n" (only when a \r is present at all).
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in source order: a refused source is reported and
  // dropped, and so is a draft. The checks run in order and the first one
  // that fails is the one reported.
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
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!compiled.has(layout)) {
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

  // 3. Permalinks: each page's directory and url, its slug made unique in
  // its directory, in source order. At the root, posts, tags and page are
  // taken from the start.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, each source's body rendered to HTML, its links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const linkCache = new Map();
  const resolveLink = (dir, target) => {
    const key = `${dir}\0${target}`;
    let hit = linkCache.get(key);
    if (hit === undefined) {
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      hit = { path, frag };
      linkCache.set(key, hit);
    }
    return hit;
  };
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const { path, frag } = resolveLink(dir, target);
        if (path !== null) {
          const page = bySource.get(path);
          if (page !== undefined) return `${page.url}${frag}`;
          if (staticPaths.has(path)) return `${base}/${path}${frag}`;
        }
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: the posts, newest date first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags: grouped by their slug, each named as first met walking the
  // posts in collection order; ordered by count of posts, then by slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const names = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); names.push(name); }
    }
    return names;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
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
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts: every page through its layout, the index pages, the tag
  // pages, then each static file at its own path unless a built page has it.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  // One include helper per case: includes resolve through it, so no closure
  // is built per rendered page or per include.
  const IN = (n, s, d) => (d < INCLUDE_DEPTH ? renderCompiled(compiled, n, s, d + 1, IN) : '');
  const render = (name, vars) => {
    if (!compiled.has(name)) return null;
    return renderCompiled(compiled, name, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, 0, IN);
  };
  for (const s of kept) {
    // A post's card is the one already built for the lists; a page's is
    // built here, once.
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
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
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
