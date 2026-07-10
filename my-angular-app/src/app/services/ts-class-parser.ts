/**
 * A lightweight tokeniser + recursive-descent parser for Angular TypeScript
 * component files. It replaces the previous regex/brace-counter approach.
 *
 * Design goals
 * ────────────
 * • Correctly skip string literals, template literals and comments — the old
 *   regex approach would match `this.foo` inside `"this.foo is zero"` or a
 *   `// this.foo` comment.
 * • Handle generic type parameters such as `getData<T extends Map<K, V>>()`.
 * • Handle all Angular property patterns: signal/computed/input/output/model/
 *   inject/linkedSignal/toSignal as well as plain class fields.
 * • Handle arrow-function class fields (`handler = (e) => { … }`).
 * • Extract the raw body text of each method so that downstream flow analysis
 *   can work on the original source, with whitespace preserved.
 */

import type { PropertyKind } from '../models/project.model';

// ─── Token types ──────────────────────────────────────────────────────────────

type TK = 'ident' | 'str' | 'tmpl' | 'num' | 'punct' | 'eof';

interface Tok {
  k: TK;
  v: string;  // exact characters from source
  p: number;  // byte offset of first character in source
}

// ─── Public output types ──────────────────────────────────────────────────────

export interface ParsedProp {
  name: string;
  kind: PropertyKind;
}

export interface ParsedMethod {
  name: string;
  params: string;
  isAsync: boolean;
  isLifecycle: boolean;
  body: string; // raw text inside the braces (empty for abstract / expression bodies)
}

export interface ParsedClass {
  className: string;
  selector: string;
  templateUrl: string | null;
  inlineTemplate: string | null;
  properties: ParsedProp[];
  methods: ParsedMethod[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LIFECYCLE = new Set([
  'ngOnInit', 'ngOnDestroy', 'ngOnChanges',
  'ngAfterViewInit', 'ngAfterViewChecked',
  'ngAfterContentInit', 'ngAfterContentChecked',
  'ngDoCheck',
]);

const MEMBER_MODIFIERS = new Set([
  'private', 'protected', 'public', 'readonly',
  'static', 'abstract', 'override', 'declare',
]);

/** Maps the first identifier after `=` to a PropertyKind. */
const INIT_KIND: Partial<Record<string, PropertyKind>> = {
  signal: 'signal', computed: 'computed',
  input: 'input', output: 'output', model: 'model',
  inject: 'inject',
  linkedSignal: 'signal', toSignal: 'signal', fromSignal: 'computed',
  resource: 'signal',
};

// ─── Tokeniser ────────────────────────────────────────────────────────────────

/**
 * Convert a TypeScript source string into a flat token array.
 * Whitespace and comments are discarded; string and template literals are
 * captured as single atomic tokens so downstream code never accidentally
 * matches inside them.
 */
export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;

  while (i < src.length) {
    const c = src.charCodeAt(i);

    // ── Whitespace ──────────────────────────────────────────────────────────
    if (c <= 32) { i++; continue; }

    // ── Line comment  // ────────────────────────────────────────────────────
    if (c === 47 && src.charCodeAt(i + 1) === 47) {
      while (i < src.length && src.charCodeAt(i) !== 10) i++;
      continue;
    }

    // ── Block comment  /* */ ────────────────────────────────────────────────
    if (c === 47 && src.charCodeAt(i + 1) === 42) {
      i += 2;
      while (i < src.length - 1 && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) i++;
      i = Math.min(i + 2, src.length);
      continue;
    }

    const p = i;

    // ── String literals  "…"  '…' ───────────────────────────────────────────
    if (c === 34 || c === 39) {
      const q = c;
      let v = src[i++];
      while (i < src.length && src.charCodeAt(i) !== q) {
        if (src.charCodeAt(i) === 92 && i + 1 < src.length) { v += src[i++]; } // backslash
        v += src[i++];
      }
      if (i < src.length) v += src[i++]; // closing quote
      out.push({ k: 'str', v, p });
      continue;
    }

    // ── Template literals  `…${expr}…` ─────────────────────────────────────
    if (c === 96) {
      let v = src[i++]; // opening `
      while (i < src.length && src.charCodeAt(i) !== 96) {
        const cc = src.charCodeAt(i);
        if (cc === 92 && i + 1 < src.length) { v += src[i++]; v += src[i++]; continue; }
        if (cc === 36 && src.charCodeAt(i + 1) === 123) {
          // ${…} interpolation — track brace depth
          v += '${'; i += 2;
          let d = 1;
          while (i < src.length && d > 0) {
            const x = src.charCodeAt(i);
            if (x === 123) d++;
            else if (x === 125) { d--; if (d === 0) { v += '}'; i++; break; } }
            v += src[i++];
          }
          continue;
        }
        v += src[i++];
      }
      if (i < src.length) v += src[i++]; // closing `
      out.push({ k: 'tmpl', v, p });
      continue;
    }

    // ── Numeric literals ────────────────────────────────────────────────────
    if (c >= 48 && c <= 57) {
      let v = '';
      while (i < src.length && /[0-9a-fA-FxXoObBeE._n]/.test(src[i])) v += src[i++];
      out.push({ k: 'num', v, p });
      continue;
    }

    // ── Identifiers and keywords ────────────────────────────────────────────
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36) {
      let v = '';
      while (i < src.length && /[a-zA-Z0-9_$]/.test(src[i])) v += src[i++];
      out.push({ k: 'ident', v, p });
      continue;
    }

    // ── Multi-character punctuation ─────────────────────────────────────────
    // Arrow: =>
    if (c === 61 && src.charCodeAt(i + 1) === 62) { out.push({ k: 'punct', v: '=>', p }); i += 2; continue; }
    // Optional chaining: ?.
    if (c === 63 && src.charCodeAt(i + 1) === 46) { out.push({ k: 'punct', v: '?.', p }); i += 2; continue; }
    // Nullish coalescing: ??
    if (c === 63 && src.charCodeAt(i + 1) === 63) { out.push({ k: 'punct', v: '??', p }); i += 2; continue; }

    // ── Single character ────────────────────────────────────────────────────
    out.push({ k: 'punct', v: src[i], p });
    i++;
  }

  out.push({ k: 'eof', v: '', p: src.length });
  return out;
}

// ─── Parser class ─────────────────────────────────────────────────────────────

class Parser {
  private i = 0;

  constructor(
    private readonly src: string,
    private readonly toks: Tok[],
  ) {}

  // ── Cursor helpers ────────────────────────────────────────────────────────

  peek(off = 0): Tok {
    const idx = this.i + off;
    return this.toks[idx] ?? { k: 'eof', v: '', p: this.src.length };
  }

  advance(): Tok {
    const t = this.toks[this.i] ?? { k: 'eof', v: '', p: this.src.length };
    if (t.k !== 'eof') this.i++;
    return t;
  }

  eat(v: string): boolean {
    if (this.peek().v === v) { this.advance(); return true; }
    return false;
  }

  is(v: string, off = 0): boolean { return this.peek(off).v === v; }
  isIdent(off = 0): boolean { return this.peek(off).k === 'ident'; }

  // ── Block / bracket helpers ───────────────────────────────────────────────

  /**
   * Starting AT the opening bracket, read until the matching close.
   * Returns the raw source text between the brackets (inner content only).
   */
  readBracketed(open: string): string {
    const CLOSE: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };
    const close = CLOSE[open] ?? open;
    if (!this.is(open)) return '';
    const startTok = this.advance(); // opening bracket
    let d = 1;
    let endPos = startTok.p + 1;

    while (d > 0 && this.peek().k !== 'eof') {
      const t = this.peek();
      if (t.v === open) d++;
      else if (t.v === close) {
        d--;
        if (d === 0) {
          this.advance();
          return this.src.slice(startTok.p + 1, t.p);
        }
      }
      endPos = t.p + t.v.length;
      this.advance();
    }
    return this.src.slice(startTok.p + 1, endPos);
  }

  /** Skip a `<…>` generic parameter block tracking nested angle brackets. */
  skipGeneric(): void {
    if (!this.is('<')) return;
    this.advance(); // '<'
    let d = 1;
    while (d > 0 && this.peek().k !== 'eof') {
      const v = this.peek().v;
      if (v === '<') d++;
      else if (v === '>') { d--; if (d === 0) { this.advance(); return; } }
      this.advance();
    }
  }

  /**
   * Skip a type annotation starting at `:`.
   * Stops (without consuming) before `=`, `;`, `{`, `)`, `,`.
   */
  skipTypeAnnotation(): void {
    if (!this.is(':')) return;
    this.advance(); // ':'
    let d = 0;
    while (this.peek().k !== 'eof') {
      const v = this.peek().v;
      if (d === 0 && (v === '=' || v === ';' || v === ')' || v === ',' || v === '{')) return;
      if (v === '(' || v === '[') d++;
      else if (v === ')' || v === ']') { if (d > 0) d--; else return; }
      else if (v === '<') d++;
      else if (v === '>') { if (d > 0) d--; }
      else if (v === '{') d++;
      else if (v === '}') { if (d > 0) d--; else return; }
      this.advance();
    }
  }

  /** Skip a decorator `@Name(…)`. Expects current token to be `@`. */
  skipDecorator(): void {
    if (!this.is('@')) return;
    this.advance(); // '@'
    if (this.isIdent()) this.advance(); // name
    if (this.is('.')) { this.advance(); if (this.isIdent()) this.advance(); } // @Ns.Dec
    if (this.is('(')) this.readBracketed('('); // arguments
  }

  /** Skip tokens until `target` at depth 0, without consuming it. */
  skipTo(target: string): void {
    let d = 0;
    while (this.peek().k !== 'eof') {
      const v = this.peek().v;
      if (d === 0 && v === target) return;
      if (v === '{' || v === '(' || v === '[') d++;
      else if (v === '}' || v === ')' || v === ']') d--;
      this.advance();
    }
  }

  // ── Initializer reading ───────────────────────────────────────────────────

  /**
   * After the `=` has been consumed, read the full initializer up to `;` or
   * an unmatched `}` (end of class body). Returns the detected PropertyKind
   * and, if it's an arrow-function field, the body text.
   */
  readInitializer(): { kind: PropertyKind; isArrowFn: boolean; body: string } {
    const initToks: Tok[] = [];
    let d = 0;

    while (this.peek().k !== 'eof') {
      const t = this.peek();
      // Stop at `;` or unmatched `}` at top level
      if (d === 0 && (t.v === ';' || t.v === '}')) break;
      if (t.v === '(' || t.v === '[' || t.v === '{') d++;
      else if (t.v === ')' || t.v === ']' || t.v === '}') { if (d > 0) d--; }
      initToks.push(t);
      this.advance();
    }
    this.eat(';');

    // ── Detect PropertyKind from the first relevant identifier ───────────────
    let kind: PropertyKind = 'regular';
    for (let j = 0; j < Math.min(initToks.length, 6); j++) {
      const t = initToks[j];
      if (t.k === 'ident') {
        if (
          t.v === 'input' &&
          initToks[j + 1]?.v === '.' &&
          initToks[j + 2]?.v === 'required'
        ) {
          kind = 'input';
        } else {
          kind = INIT_KIND[t.v] ?? 'regular';
        }
        break;
      }
    }

    // ── Detect arrow function: `=>` at parenthesis depth 0 ──────────────────
    let arrowIdx = -1;
    let dd = 0;
    for (let j = 0; j < initToks.length; j++) {
      const v = initToks[j].v;
      if (v === '(' || v === '[' || v === '{') dd++;
      else if (v === ')' || v === ']' || v === '}') { if (dd > 0) dd--; }
      else if (v === '=>' && dd === 0) { arrowIdx = j; break; }
    }

    const isArrowFn = arrowIdx >= 0;
    let body = '';

    if (isArrowFn) {
      const afterArrow = initToks[arrowIdx + 1];
      if (afterArrow?.v === '{') {
        // Block body: raw text between `{` and its matching `}`
        const bodyStart = afterArrow.p + 1;
        const last = initToks[initToks.length - 1];
        body = last?.v === '}' ? this.src.slice(bodyStart, last.p) : '';
      } else if (afterArrow) {
        // Expression body — wrap in return so the flow parser has something to work with
        const exprToks = initToks.slice(arrowIdx + 1);
        body = `return ${exprToks.map(t => t.v).join(' ')};`;
      }
    }

    return { kind, isArrowFn, body };
  }

  // ── @Component decorator ─────────────────────────────────────────────────

  /**
   * Scan forward to find `@Component({…})` and extract `selector`,
   * `templateUrl`, and `template`. Resets internal cursor on each call.
   */
  parseComponentDecorator(): {
    selector: string;
    templateUrl: string | null;
    inlineTemplate: string | null;
  } {
    let selector = '';
    let templateUrl: string | null = null;
    let inlineTemplate: string | null = null;

    while (this.peek().k !== 'eof') {
      // Look for `@Component`
      if (this.is('@') && this.peek(1).v === 'Component') {
        this.advance(); // '@'
        this.advance(); // 'Component'
        if (!this.is('(')) break;
        this.advance(); // '('
        if (!this.is('{')) break;
        this.advance(); // '{'

        let depth = 1;
        while (depth > 0 && this.peek().k !== 'eof') {
          const t = this.peek();
          if (t.v === '{') { depth++; this.advance(); continue; }
          if (t.v === '}') { depth--; if (depth === 0) break; this.advance(); continue; }

          // Only parse keys at the top level of the decorator object
          if (depth === 1 && t.k === 'ident') {
            const key = this.advance().v;
            if (!this.eat(':')) { this.skipTo('}'); break; }

            const val = this.peek();
            if (key === 'selector' && (val.k === 'str')) {
              selector = unquote(this.advance().v);
            } else if (key === 'templateUrl' && val.k === 'str') {
              templateUrl = unquote(this.advance().v);
            } else if (key === 'template' && (val.k === 'str' || val.k === 'tmpl')) {
              inlineTemplate = unquote(this.advance().v);
            } else {
              this.skipDecoratorValue();
            }
            this.eat(',');
            continue;
          }
          this.advance();
        }
        break;
      }
      this.advance();
    }

    return { selector, templateUrl, inlineTemplate };
  }

  /** Skip a value in a decorator object, stopping before `,` or `}` at depth 0. */
  private skipDecoratorValue(): void {
    let d = 0;
    while (this.peek().k !== 'eof') {
      const v = this.peek().v;
      if (d === 0 && (v === ',' || v === '}')) return;
      if (v === '(' || v === '[' || v === '{') d++;
      else if (v === ')' || v === ']' || v === '}') { if (d > 0) d--; else return; }
      this.advance();
    }
  }

  // ── Class-body parsing ────────────────────────────────────────────────────

  /** Find `class Name` and advance past it, stopping just before the `{`. */
  findClassOpening(): string {
    while (this.peek().k !== 'eof') {
      if (this.peek().v === 'class' && this.peek().k === 'ident') {
        this.advance(); // 'class'
        if (this.isIdent()) {
          const name = this.advance().v;
          // Skip extends / implements
          while (!this.is('{') && this.peek().k !== 'eof') this.advance();
          return name;
        }
      }
      this.advance();
    }
    return '';
  }

  /** Parse the class body (cursor should be pointing AT the `{`). */
  parseClassBody(): { properties: ParsedProp[]; methods: ParsedMethod[] } {
    const properties: ParsedProp[] = [];
    const methods: ParsedMethod[] = [];
    const seen = new Set<string>();

    if (!this.is('{')) return { properties, methods };
    this.advance(); // opening '{'

    while (!this.is('}') && this.peek().k !== 'eof') {
      // Skip any decorators on this member
      while (this.is('@')) this.skipDecorator();
      if (this.is('}') || this.peek().k === 'eof') break;

      // Collect modifiers
      let isAsync = false;
      const mods: string[] = [];
      while (MEMBER_MODIFIERS.has(this.peek().v) || this.peek().v === 'async') {
        const m = this.advance().v;
        if (m === 'async') isAsync = true;
        else mods.push(m);
      }

      // Constructor — extract parameter-injected properties
      if (this.peek().v === 'constructor') {
        this.advance();
        const paramProps = this.parseConstructorParams();
        for (const p of paramProps) {
          if (!seen.has(p.name)) { seen.add(p.name); properties.push(p); }
        }
        if (this.is('{')) this.readBracketed('{'); // skip body
        continue;
      }

      // Index signature `[key: string]: Type` — skip
      if (this.is('[')) {
        this.readBracketed('[');
        this.skipTypeAnnotation();
        this.eat(';');
        continue;
      }

      // Member name must be an identifier
      if (!this.isIdent()) { this.advance(); continue; }
      const name = this.advance().v;

      // Skip generic type params on the member: `name<T>(…)`
      if (this.is('<')) this.skipGeneric();

      if (seen.has(name)) {
        // Already handled; skip to end of declaration
        this.skipMember();
        continue;
      }
      seen.add(name);

      if (this.is('(')) {
        // ── Regular or async method ──────────────────────────────────────
        const params = this.readBracketed('(').trim();
        this.skipTypeAnnotation(); // : ReturnType
        const body = this.is('{') ? this.readBracketed('{') : '';
        this.eat(';');
        methods.push({ name, params, isAsync, isLifecycle: LIFECYCLE.has(name), body });
      } else {
        // ── Property or arrow-function class field ────────────────────────
        this.eat('?'); this.eat('!'); // optional / non-null
        this.skipTypeAnnotation();   // : Type

        if (!this.is('=')) {
          // Declaration-only, e.g. `private foo: string;`
          this.eat(';');
          properties.push({ name, kind: 'regular' });
          continue;
        }
        this.advance(); // '='

        const { kind, isArrowFn, body } = this.readInitializer();

        if (isArrowFn) {
          methods.push({ name, params: '', isAsync, isLifecycle: LIFECYCLE.has(name), body });
        } else {
          properties.push({ name, kind });
        }
      }
    }

    return { properties, methods };
  }

  /** Parse constructor `(…)` and return any parameter-injected properties. */
  private parseConstructorParams(): ParsedProp[] {
    const props: ParsedProp[] = [];
    if (!this.is('(')) return props;
    this.advance(); // '('

    while (!this.is(')') && this.peek().k !== 'eof') {
      while (this.is('@')) this.skipDecorator(); // param decorators
      const hasMod = MEMBER_MODIFIERS.has(this.peek().v);
      while (MEMBER_MODIFIERS.has(this.peek().v)) this.advance();
      if (this.isIdent()) {
        const name = this.advance().v;
        this.eat('?'); this.eat('!');
        this.skipTypeAnnotation();
        if (this.eat('=')) {
          // Default value — skip to `,` or `)`
          let d = 0;
          while (this.peek().k !== 'eof') {
            const v = this.peek().v;
            if (d === 0 && (v === ',' || v === ')')) break;
            if (v === '(' || v === '[' || v === '{') d++;
            else if (v === ')' || v === ']' || v === '}') { if (d > 0) d--; }
            this.advance();
          }
        }
        if (hasMod) props.push({ name, kind: 'inject' });
      }
      this.eat(',');
    }
    this.eat(')');
    return props;
  }

  /** Skip past the current member (used when we see a duplicate name). */
  private skipMember(): void {
    if (this.is('(')) { this.readBracketed('('); this.skipTypeAnnotation(); }
    if (this.is('{')) { this.readBracketed('{'); return; }
    let d = 0;
    while (this.peek().k !== 'eof') {
      const v = this.peek().v;
      if (d === 0 && (v === ';' || v === '}')) { this.eat(';'); return; }
      if (v === '{' || v === '(' || v === '[') d++;
      else if (v === '}' || v === ')' || v === ']') { if (d > 0) d--; else return; }
      this.advance();
    }
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Strip surrounding quotes from a token value. */
function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('`') && s.endsWith('`'))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function classNameToSelector(name: string): string {
  const base = name
    .replace(/Component$/, '')
    .replace(/([A-Z])/g, (_, l, idx) => (idx > 0 ? '-' : '') + l.toLowerCase());
  return base.startsWith('-') ? `app${base}` : `app-${base}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a single Angular component TypeScript file and return structured info.
 * Returns `null` if no `@Component` decorator or class declaration is found.
 */
export function parseAngularComponent(src: string): ParsedClass | null {
  if (!src.includes('@Component')) return null;

  const toks = tokenize(src);

  // Pass 1: extract @Component decorator metadata
  const decParser = new Parser(src, toks);
  const { selector, templateUrl, inlineTemplate } = decParser.parseComponentDecorator();

  // Pass 2: find the class and parse its body
  const classParser = new Parser(src, toks);
  const className = classParser.findClassOpening();
  if (!className) return null;

  const { properties, methods } = classParser.parseClassBody();

  return {
    className,
    selector: selector || classNameToSelector(className),
    templateUrl: templateUrl ?? null,
    inlineTemplate: inlineTemplate ?? null,
    properties,
    methods,
  };
}

/**
 * Find every `this.propName` access in a method body string.
 * Because we tokenise first, occurrences inside string/template literals
 * and comments are correctly ignored.
 *
 * Template literal interpolations `${…}` are also scanned recursively so
 * that `\`count is ${this.count()}\`` is caught.
 */
export function findThisAccesses(
  body: string,
): { name: string; isCall: boolean }[] {
  const toks = tokenize(body);
  const result: { name: string; isCall: boolean }[] = [];

  for (let i = 0; i < toks.length - 2; i++) {
    const t = toks[i];

    // Recurse into template literal interpolations
    if (t.k === 'tmpl') {
      for (const expr of extractTmplExpressions(t.v)) {
        result.push(...findThisAccesses(expr));
      }
      continue;
    }

    // this . name
    if (t.k === 'ident' && t.v === 'this' && toks[i + 1]?.v === '.') {
      const nameTok = toks[i + 2];
      if (nameTok?.k === 'ident') {
        // Treat `this.foo()` and `this.foo?.()` as calls
        const next = toks[i + 3]?.v ?? '';
        const isCall = next === '(' || (next === '?.' && toks[i + 4]?.v === '(');
        result.push({ name: nameTok.v, isCall });
        i += 2; // skip past the property name
      }
    }
  }

  return result;
}

/** Extract the contents of `${…}` expressions from a raw template-literal string. */
function extractTmplExpressions(tmpl: string): string[] {
  const exprs: string[] = [];
  let i = 0;
  while (i < tmpl.length - 1) {
    if (tmpl[i] === '$' && tmpl[i + 1] === '{') {
      i += 2;
      let d = 1;
      let expr = '';
      while (i < tmpl.length && d > 0) {
        if (tmpl[i] === '{') d++;
        else if (tmpl[i] === '}') { d--; if (d === 0) break; }
        expr += tmpl[i++];
      }
      exprs.push(expr);
    }
    i++;
  }
  return exprs;
}
