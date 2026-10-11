'use strict';
// Allow-list HTML sanitizer for rich text (terms & conditions). Unknown tags are dropped, attributes are filtered.
const ALLOWED = { p: [], br: [], b: [], strong: [], i: [], em: [], u: [], s: [], ul: [], ol: [], li: [], h2: [], h3: [], h4: [], blockquote: [], hr: [], a: ['href', 'target'], span: [], div: [] };
const VOID = new Set(['br', 'hr']);

function escapeText(s) { return s.replace(/&(?!(?:[a-z]+|#\d+|#x[0-9a-f]+);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

function sanitizeHtml(input) {
  const html = String(input || '').slice(0, 50000)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|template|noscript|svg|math)[\s\S]*?<\/\1\s*>/gi, '');
  let out = '';
  const stack = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)|(<)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[3] != null) { out += escapeText(m[3]); continue; }
    if (m[4]) { out += '&lt;'; continue; }
    const tag = m[1].toLowerCase();
    const closing = m[0].startsWith('</');
    if (!ALLOWED[tag]) continue;
    if (closing) {
      const idx = stack.lastIndexOf(tag);
      if (idx === -1) continue;
      while (stack.length > idx) out += `</${stack.pop()}>`;
      continue;
    }
    let attrs = '';
    const ar = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let a;
    while ((a = ar.exec(m[2]))) {
      const name = a[1].toLowerCase();
      const val = a[3] ?? a[4] ?? a[5] ?? '';
      if (!ALLOWED[tag].includes(name)) continue;
      if (name === 'href' && !/^(https?:|mailto:|tel:|line:)/i.test(val.trim())) continue;
      if (name === 'target' && val !== '_blank') continue;
      attrs += ` ${name}="${escAttr(val)}"`;
    }
    if (tag === 'a' && /target=/.test(attrs)) attrs += ' rel="noopener noreferrer"';
    out += `<${tag}${attrs}>`;
    if (!VOID.has(tag)) stack.push(tag);
  }
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}

module.exports = { sanitizeHtml };
