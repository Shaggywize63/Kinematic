/**
 * Safe expression evaluator for `formula` custom fields.
 *
 * Supports a deliberately narrow language so it can be evaluated on
 * every read of every lead / contact / account / deal without becoming
 * a runtime risk:
 *
 *   - numeric literals: 12, 3.14
 *   - string literals:   "hello"  (only used inside IF branches)
 *   - field refs:        {price}, {qty}             — values pulled from custom_fields
 *   - operators:         + - * / parentheses, < <= > >= == !=
 *   - functions:         IF(cond, then, else), MIN(a,b,…), MAX(a,b,…),
 *                        ROUND(value, decimals)
 *
 * The implementation is a hand-written recursive-descent parser; we
 * deliberately do NOT use `eval`, `new Function`, or any dependency
 * that could expand the attack surface. Field refs that don't exist
 * (or are blank) resolve to 0 for numeric contexts and "" for string
 * contexts so a half-filled form doesn't blow up.
 */

export type FormulaInput = Record<string, unknown>;

/**
 * Evaluate `expr` against the lookup map `values`. Returns either a
 * number, string, boolean, or null when the expression couldn't be
 * computed (bad syntax, unknown function, …). Never throws.
 */
export function evaluateFormula(expr: string, values: FormulaInput): number | string | boolean | null {
  try {
    const tokens = tokenize(expr);
    const parser = new Parser(tokens, values);
    const result = parser.parseExpression();
    parser.expectEnd();
    return result;
  } catch {
    return null;
  }
}

// ── Tokens ─────────────────────────────────────────────────────

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'ref'; key: string }
  | { kind: 'ident'; name: string }
  | { kind: 'op'; op: string }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'comma' };

const RESERVED_FNS = new Set(['IF', 'MIN', 'MAX', 'ROUND']);

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '(') { out.push({ kind: 'lparen' }); i++; continue; }
    if (c === ')') { out.push({ kind: 'rparen' }); i++; continue; }
    if (c === ',') { out.push({ kind: 'comma' }); i++; continue; }
    if (c === '+' || c === '-' || c === '*' || c === '/') {
      out.push({ kind: 'op', op: c }); i++; continue;
    }
    if (c === '<' || c === '>' || c === '=' || c === '!') {
      // Two-char operators: <= >= == !=
      if (src[i + 1] === '=') { out.push({ kind: 'op', op: c + '=' }); i += 2; continue; }
      if (c === '<' || c === '>') { out.push({ kind: 'op', op: c }); i++; continue; }
      throw new Error('bad operator');
    }
    if (c === '{') {
      const end = src.indexOf('}', i + 1);
      if (end < 0) throw new Error('unterminated field ref');
      const key = src.slice(i + 1, end).trim();
      if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error('bad field key');
      out.push({ kind: 'ref', key });
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      const end = src.indexOf(quote, i + 1);
      if (end < 0) throw new Error('unterminated string');
      out.push({ kind: 'str', value: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const n = Number(src.slice(i, j));
      if (!Number.isFinite(n)) throw new Error('bad number');
      out.push({ kind: 'num', value: n });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      const name = src.slice(i, j);
      out.push({ kind: 'ident', name });
      i = j;
      continue;
    }
    throw new Error('unexpected char');
  }
  return out;
}

// ── Parser ─────────────────────────────────────────────────────

class Parser {
  private pos = 0;
  constructor(private tokens: Token[], private values: FormulaInput) {}

  expectEnd() {
    if (this.pos !== this.tokens.length) throw new Error('trailing tokens');
  }

  /** Comparison level — lowest precedence (returns boolean when used). */
  parseExpression(): number | string | boolean {
    const left = this.parseAdd();
    const t = this.peek();
    if (t && t.kind === 'op' && (t.op === '<' || t.op === '>' || t.op === '<=' || t.op === '>=' || t.op === '==' || t.op === '!=')) {
      this.pos++;
      const right = this.parseAdd();
      const a = numOrStr(left), b = numOrStr(right);
      switch (t.op) {
        case '<':  return (a as number) <  (b as number);
        case '>':  return (a as number) >  (b as number);
        case '<=': return (a as number) <= (b as number);
        case '>=': return (a as number) >= (b as number);
        case '==': return a === b;
        case '!=': return a !== b;
      }
    }
    return left;
  }

  private parseAdd(): number | string {
    let left = this.parseMul();
    while (true) {
      const t = this.peek();
      if (!t || t.kind !== 'op') break;
      if (t.op !== '+' && t.op !== '-') break;
      this.pos++;
      const right = this.parseMul();
      left = (t.op === '+' ? toNum(left) + toNum(right) : toNum(left) - toNum(right));
    }
    return left;
  }

  private parseMul(): number | string {
    let left = this.parseUnary();
    while (true) {
      const t = this.peek();
      if (!t || t.kind !== 'op') break;
      if (t.op !== '*' && t.op !== '/') break;
      this.pos++;
      const right = this.parseUnary();
      if (t.op === '*') {
        left = toNum(left) * toNum(right);
      } else {
        const divisor = toNum(right);
        left = divisor === 0 ? 0 : toNum(left) / divisor;
      }
    }
    return left;
  }

  private parseUnary(): number | string {
    const t = this.peek();
    if (t && t.kind === 'op' && (t.op === '+' || t.op === '-')) {
      this.pos++;
      const v = toNum(this.parseUnary());
      return t.op === '-' ? -v : v;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number | string {
    const t = this.advance();
    if (!t) throw new Error('unexpected end');
    if (t.kind === 'num') return t.value;
    if (t.kind === 'str') return t.value;
    if (t.kind === 'ref') {
      const v = this.values[t.key];
      if (v === undefined || v === null || v === '') return 0;
      const n = Number(v);
      return Number.isFinite(n) ? n : String(v);
    }
    if (t.kind === 'lparen') {
      const v = this.parseExpression();
      const c = this.advance();
      if (!c || c.kind !== 'rparen') throw new Error('expected )');
      return numOrStrAsValue(v);
    }
    if (t.kind === 'ident') {
      const name = t.name.toUpperCase();
      if (!RESERVED_FNS.has(name)) throw new Error('unknown identifier');
      const lp = this.advance();
      if (!lp || lp.kind !== 'lparen') throw new Error('expected (');
      const args: Array<number | string | boolean> = [];
      // First arg (or zero args)
      if (this.peek()?.kind !== 'rparen') {
        args.push(this.parseExpression());
        while (this.peek()?.kind === 'comma') {
          this.pos++;
          args.push(this.parseExpression());
        }
      }
      const rp = this.advance();
      if (!rp || rp.kind !== 'rparen') throw new Error('expected )');
      return callFn(name, args);
    }
    throw new Error('unexpected token');
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private advance(): Token | undefined { return this.tokens[this.pos++]; }
}

function callFn(name: string, args: Array<number | string | boolean>): number | string {
  switch (name) {
    case 'IF': {
      if (args.length < 3) throw new Error('IF needs 3 args');
      const cond = args[0];
      const truthy = typeof cond === 'boolean' ? cond : !!cond;
      return numOrStrAsValue(truthy ? args[1] : args[2]);
    }
    case 'MIN': {
      const nums = args.map(toNum);
      return Math.min(...nums);
    }
    case 'MAX': {
      const nums = args.map(toNum);
      return Math.max(...nums);
    }
    case 'ROUND': {
      const v = toNum(args[0]);
      const d = args.length > 1 ? Math.max(0, Math.min(10, Math.floor(toNum(args[1])))) : 0;
      const f = Math.pow(10, d);
      return Math.round(v * f) / f;
    }
  }
  throw new Error('unknown function');
}

function toNum(v: number | string | boolean | null | undefined): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrStr(v: number | string | boolean): number | string {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function numOrStrAsValue(v: number | string | boolean): number | string {
  return numOrStr(v);
}

/**
 * Compute every formula custom field defined for `entity` against the
 * row's existing `custom_fields` map and return a NEW object with the
 * computed values stamped under each formula field's `field_key`.
 * Non-formula keys are passed through untouched. Cheap to call on every
 * read; no DB hit if `defs` is precomputed.
 */
export function stampFormulaValues(
  defs: Array<{ field_key: string; field_type: string; formula?: string | null }>,
  customFields: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const base = customFields && typeof customFields === 'object' ? { ...customFields } : {};
  for (const d of defs) {
    if (d.field_type !== 'formula' || !d.formula) continue;
    const value = evaluateFormula(d.formula, base);
    if (value !== null) base[d.field_key] = value;
  }
  return base;
}
