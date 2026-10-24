'use strict';
// Tiny tolerant XML helpers for Tally's export format. Tally output is regular
// (no namespaces, no CDATA) but contains invalid control chars such as "&#4;",
// which break real XML parsers - hence this purpose-built reader.

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

function clean(xml) {
  return String(xml).replace(/&#(?:[0-8]|1[0-9]|2[0-9]|30|31|11|12);/g, '');
}
function decode(s) {
  return String(s)
    .replace(/&(amp|lt|gt|quot|apos);/g, m => ENT[m])
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every <tag ...>inner</tag> -> { attrs, inner }. Non-nested use only (same tag inside itself is not supported). */
function blocks(xml, tag) {
  const re = new RegExp(`<${esc(tag)}(\\s[^>]*)?>([\\s\\S]*?)</${esc(tag)}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push({ attrs: parseAttrs(m[1] || ''), inner: m[2] });
  return out;
}
function parseAttrs(s) {
  const attrs = {};
  const re = /([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) attrs[m[1].toUpperCase()] = decode(m[2]);
  return attrs;
}
/** First direct-ish child text <tag>text</tag> (decoded, trimmed) or ''. */
function child(inner, tag) {
  const m = new RegExp(`<${esc(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(tag)}>`, 'i').exec(inner);
  return m ? decode(m[1]).trim() : '';
}
function xmlEscape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { clean, decode, blocks, child, xmlEscape };
