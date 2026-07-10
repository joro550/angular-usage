import { Injectable } from '@angular/core';

// ─── AST node types ───────────────────────────────────────────────────────────

export interface FlowBranch {
  kind: 'if' | 'else-if' | 'else';
  condition: string | null; // null for else
  body: FlowNode[];
}

export interface SwitchCase {
  label: string;
  isDefault: boolean;
  body: FlowNode[];
}

export interface FlowNode {
  id: string;
  nodeKind: 'code' | 'if' | 'switch' | 'return' | 'throw' | 'loop';
  text?: string;         // code / return / throw text
  branches?: FlowBranch[]; // if chain
  switchExpr?: string;
  cases?: SwitchCase[];
  loopHeader?: string;
  loopBody?: FlowNode[];
}

// ─── Evaluated types (runtime-annotated) ─────────────────────────────────────

export interface EvaluatedBranch extends FlowBranch {
  result: boolean | null;   // null = couldn't evaluate
  substituted: string | null;
  taken: boolean;
}

export interface EvaluatedCase extends SwitchCase {
  result: boolean | null;
  taken: boolean;
}

export interface EvaluatedNode {
  id: string;
  nodeKind: FlowNode['nodeKind'];
  text?: string;
  branches?: EvaluatedBranch[];
  switchExpr?: string;
  cases?: EvaluatedCase[];
  loopHeader?: string;
  takenBranchIdx: number | null;
  takenCaseIdx: number | null;
  subNodes?: EvaluatedNode[]; // nodes within the taken branch/case
}

// ─── Flat display items (tree flattened for simple rendering) ─────────────────

export type FlowItemType =
  | 'code' | 'if-head' | 'switch-head' | 'switch-case'
  | 'return' | 'throw' | 'loop' | 'separator';

export interface FlowDisplayItem {
  type: FlowItemType;
  depth: number;
  text?: string;
  condition?: string;
  substituted?: string;
  result?: boolean | null;
  taken?: boolean;
  isElse?: boolean;
  caseLabel?: string;
  loopHeader?: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class FlowParserService {
  private _seq = 0;
  private uid(): string { return `n${this._seq++}`; }

  // ── Public API ─────────────────────────────────────────────────────────────

  parse(body: string): FlowNode[] {
    this._seq = 0;
    return this.parseBlock(body, 0, body.length).nodes;
  }

  evaluate(nodes: FlowNode[], rawInputs: Record<string, string>): EvaluatedNode[] {
    const values = this.parseInputs(rawInputs);
    return nodes.map(n => this.evalNode(n, values));
  }

  /** Flatten an evaluated tree into a simple ordered display list. */
  flatten(nodes: EvaluatedNode[], depth = 0): FlowDisplayItem[] {
    const out: FlowDisplayItem[] = [];
    for (const node of nodes) {
      switch (node.nodeKind) {
        case 'code':
          if (node.text?.trim()) {
            out.push({ type: 'code', depth, text: this.truncate(node.text, 80) });
          }
          break;

        case 'if': {
          const branches = node.branches ?? [];
          for (let i = 0; i < branches.length; i++) {
            const br = branches[i];
            out.push({
              type: 'if-head',
              depth,
              text: br.kind === 'else' ? 'else'
                : `${br.kind === 'else-if' ? 'else if' : 'if'} (${br.condition})`,
              condition: br.condition ?? undefined,
              substituted: br.substituted ?? undefined,
              result: br.result,
              taken: br.taken,
              isElse: br.kind === 'else',
            });
            if (br.taken && node.subNodes?.length) {
              out.push(...this.flatten(node.subNodes, depth + 1));
            }
          }
          break;
        }

        case 'switch': {
          out.push({ type: 'switch-head', depth, switchExpr: node.switchExpr, text: `switch (${node.switchExpr})` } as FlowDisplayItem);
          const cases = node.cases ?? [];
          for (let i = 0; i < cases.length; i++) {
            const c = cases[i];
            out.push({
              type: 'switch-case',
              depth: depth + 1,
              caseLabel: c.isDefault ? 'default' : `case ${c.label}`,
              taken: node.takenCaseIdx === i,
              result: node.takenCaseIdx !== null ? node.takenCaseIdx === i : null,
            });
            if (node.takenCaseIdx === i && node.subNodes?.length) {
              out.push(...this.flatten(node.subNodes, depth + 2));
            }
          }
          break;
        }

        case 'return':
          out.push({ type: 'return', depth, text: node.text });
          break;
        case 'throw':
          out.push({ type: 'throw', depth, text: node.text });
          break;
        case 'loop':
          out.push({ type: 'loop', depth, loopHeader: node.loopHeader, text: node.loopHeader });
          break;
      }
    }
    return out;
  }

  // ── Value input helpers ────────────────────────────────────────────────────

  /**
   * Walk the parsed tree and collect every `this.propName` that appears inside
   * a branching expression: if/else-if condition, switch discriminant, loop guard,
   * or a ternary operator's condition part (before the first `?`).
   *
   * These are the properties whose values directly determine which code path runs.
   */
  extractConditionProps(nodes: FlowNode[]): Set<string> {
    const out = new Set<string>();
    this.gatherConditionProps(nodes, out);
    return out;
  }

  private gatherConditionProps(nodes: FlowNode[], out: Set<string>): void {
    for (const node of nodes) {
      switch (node.nodeKind) {
        case 'if':
          for (const branch of node.branches ?? []) {
            // The condition itself
            if (branch.condition) this.propsInExpr(branch.condition, out);
            // Recurse into the branch body (nested ifs etc.)
            this.gatherConditionProps(branch.body, out);
          }
          break;

        case 'switch':
          // The discriminant expression (e.g. this.mode())
          if (node.switchExpr) this.propsInExpr(node.switchExpr, out);
          for (const c of node.cases ?? []) this.gatherConditionProps(c.body, out);
          break;

        case 'loop':
          // Loop guard/header (e.g. while (this.running))
          if (node.loopHeader) this.propsInExpr(node.loopHeader, out);
          this.gatherConditionProps(node.loopBody ?? [], out);
          break;

        case 'code':
        case 'return':
        case 'throw': {
          // Detect ternary conditions: extract the part before the first standalone `?`
          const text = node.text ?? '';
          const qi = this.findTernaryQuestion(text);
          if (qi >= 0) this.propsInExpr(text.slice(0, qi), out);
          break;
        }
      }
    }
  }

  /** Find the index of a top-level `?` in a string (skips nested parens/strings). */
  private findTernaryQuestion(src: string): number {
    let depth = 0;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '(' || c === '[') { depth++; continue; }
      if (c === ')' || c === ']') { depth--; continue; }
      if ((c === '"' || c === "'" || c === '`') && depth === 0) {
        i = this.skipStr(src, i) - 1;
        continue;
      }
      if (c === '?' && depth === 0 && src[i + 1] !== '?' && src[i - 1] !== '?') return i;
    }
    return -1;
  }

  /** Extract all `this.propName` identifiers from an expression string. */
  private propsInExpr(expr: string, out: Set<string>): void {
    const pat = /\bthis\.(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(expr)) !== null) out.add(m[1]);
  }

  parseValue(raw: string): unknown {
    const t = raw.trim();
    if (t === '' || t === 'undefined') return undefined;
    if (t === 'null') return null;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t !== '' && !isNaN(Number(t))) return Number(t);
    try { return JSON.parse(t); } catch { /* fall through */ }
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      return t.slice(1, -1);
    }
    return t;
  }

  // ── Parsing ────────────────────────────────────────────────────────────────

  private parseBlock(src: string, from: number, to: number): { nodes: FlowNode[]; end: number } {
    const nodes: FlowNode[] = [];
    let i = from;
    let codeBuf = '';

    const flushCode = () => {
      const t = codeBuf.trim();
      if (t) nodes.push({ id: this.uid(), nodeKind: 'code', text: t });
      codeBuf = '';
    };

    while (i < to) {
      i = this.skipWS(src, i);
      if (i >= to) break;

      // Skip line comments
      if (src[i] === '/' && src[i + 1] === '/') {
        while (i < to && src[i] !== '\n') i++;
        continue;
      }
      // Skip block comments
      if (src[i] === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < to - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i += 2;
        continue;
      }

      // Keywords
      if (this.kw(src, i, 'if')) {
        flushCode();
        const r = this.parseIf(src, i, to);
        nodes.push(r.node); i = r.end; continue;
      }
      if (this.kw(src, i, 'else')) {
        // orphan else — shouldn't happen with correct parsing, skip
        i++; continue;
      }
      if (this.kw(src, i, 'switch')) {
        flushCode();
        const r = this.parseSwitch(src, i, to);
        nodes.push(r.node); i = r.end; continue;
      }
      if (this.kw(src, i, 'return')) {
        flushCode();
        const e = this.stmtEnd(src, i, to);
        nodes.push({ id: this.uid(), nodeKind: 'return', text: src.slice(i, e + 1).trim() });
        i = e + 1; continue;
      }
      if (this.kw(src, i, 'throw')) {
        flushCode();
        const e = this.stmtEnd(src, i, to);
        nodes.push({ id: this.uid(), nodeKind: 'throw', text: src.slice(i, e + 1).trim() });
        i = e + 1; continue;
      }
      if (this.kw(src, i, 'for') || this.kw(src, i, 'while') || this.kw(src, i, 'do')) {
        flushCode();
        const r = this.parseLoop(src, i, to);
        nodes.push(r.node); i = r.end; continue;
      }

      // Regular code accumulation
      const ch = src[i];
      if (ch === '"' || ch === "'" || ch === '`') {
        const e = this.skipStr(src, i);
        codeBuf += src.slice(i, e);
        i = e;
      } else if (ch === '{') {
        const e = this.closeBrace(src, i);
        codeBuf += src.slice(i, e + 1);
        i = e + 1;
      } else {
        codeBuf += ch;
        if (ch === ';') {
          const t = codeBuf.trim();
          if (t && t !== ';') nodes.push({ id: this.uid(), nodeKind: 'code', text: t });
          codeBuf = '';
        }
        i++;
      }
    }
    flushCode();
    return { nodes, end: i };
  }

  private parseIf(src: string, pos: number, limit: number): { node: FlowNode; end: number } {
    const branches: FlowBranch[] = [];
    let i = pos;
    let first = true;

    while (i < limit) {
      i = this.skipWS(src, i);
      let kind: FlowBranch['kind'] = 'if';

      if (!first) {
        if (!this.kw(src, i, 'else')) break;
        i += 4; i = this.skipWS(src, i);
        if (this.kw(src, i, 'if')) { kind = 'else-if'; i += 2; i = this.skipWS(src, i); }
        else kind = 'else';
      } else {
        i += 2; i = this.skipWS(src, i); // skip 'if'
        first = false;
      }

      let condition: string | null = null;
      if (kind !== 'else' && src[i] === '(') {
        const { content, end } = this.extractParen(src, i);
        condition = content;
        i = end + 1;
      }

      i = this.skipWS(src, i);
      let bodyNodes: FlowNode[] = [];

      if (src[i] === '{') {
        const e = this.closeBrace(src, i);
        const inner = src.slice(i + 1, e);
        bodyNodes = this.parseBlock(inner, 0, inner.length).nodes;
        i = e + 1;
      } else {
        // single-statement body
        const e = this.stmtEnd(src, i, limit);
        const t = src.slice(i, e + 1).trim();
        if (t) bodyNodes = [{ id: this.uid(), nodeKind: 'code', text: t }];
        i = e + 1;
      }

      branches.push({ kind, condition, body: bodyNodes });
      if (kind === 'else') break;

      // Peek for 'else'
      const peek = this.skipWS(src, i);
      if (!this.kw(src, peek, 'else')) break;
    }

    return { node: { id: this.uid(), nodeKind: 'if', branches }, end: i };
  }

  private parseSwitch(src: string, pos: number, _limit: number): { node: FlowNode; end: number } {
    let i = pos + 6; // 'switch'
    i = this.skipWS(src, i);
    let switchExpr = '';
    if (src[i] === '(') { const { content, end } = this.extractParen(src, i); switchExpr = content; i = end + 1; }
    i = this.skipWS(src, i);

    const cases: SwitchCase[] = [];
    if (src[i] === '{') {
      const bodyEnd = this.closeBrace(src, i);
      const body = src.slice(i + 1, bodyEnd);
      let j = 0;

      while (j < body.length) {
        j = this.skipWS(body, j);
        if (j >= body.length) break;

        let label = '';
        let isDefault = false;

        if (this.kw(body, j, 'default')) {
          isDefault = true; label = 'default'; j += 7;
          j = this.skipWS(body, j);
          if (body[j] === ':') j++;
        } else if (this.kw(body, j, 'case')) {
          j += 4; j = this.skipWS(body, j);
          const col = this.findCaseColon(body, j);
          label = body.slice(j, col).trim();
          j = col + 1;
        } else { j++; continue; }

        // Collect until next case / default
        let caseEnd = j;
        while (caseEnd < body.length) {
          const peek = this.skipWS(body, caseEnd);
          if (this.kw(body, peek, 'case') || this.kw(body, peek, 'default')) break;
          if (body[caseEnd] === '"' || body[caseEnd] === "'" || body[caseEnd] === '`') {
            caseEnd = this.skipStr(body, caseEnd);
          } else if (body[caseEnd] === '{') {
            caseEnd = this.closeBrace(body, caseEnd) + 1;
          } else { caseEnd++; }
        }
        const caseStr = body.slice(j, caseEnd);
        cases.push({ label, isDefault, body: this.parseBlock(caseStr, 0, caseStr.length).nodes });
        j = caseEnd;
      }
      i = bodyEnd + 1;
    }
    return { node: { id: this.uid(), nodeKind: 'switch', switchExpr, cases }, end: i };
  }

  private parseLoop(src: string, pos: number, _limit: number): { node: FlowNode; end: number } {
    let i = pos;
    const isDo = this.kw(src, i, 'do');
    if (this.kw(src, i, 'while')) i += 5;
    else if (isDo) i += 2;
    else i += 3; // 'for'

    i = this.skipWS(src, i);
    let loopHeader = '';
    let loopBody: FlowNode[] = [];

    if (isDo) {
      if (src[i] === '{') {
        const e = this.closeBrace(src, i);
        const inner = src.slice(i + 1, e);
        loopBody = this.parseBlock(inner, 0, inner.length).nodes;
        i = e + 1;
      }
      i = this.skipWS(src, i);
      if (this.kw(src, i, 'while')) i += 5;
      i = this.skipWS(src, i);
      if (src[i] === '(') { const { content, end } = this.extractParen(src, i); loopHeader = `do … while (${content})`; i = end + 1; }
    } else {
      if (src[i] === '(') { const { content, end } = this.extractParen(src, i); loopHeader = `${pos === i - (content.length + 2) ? '' : ''}(${content})`; i = end + 1; }
      i = this.skipWS(src, i);
      // Arrow function body or block
      if (src[i] === '=' && src[i + 1] === '>') { i += 2; i = this.skipWS(src, i); }
      if (src[i] === '{') {
        const e = this.closeBrace(src, i);
        const inner = src.slice(i + 1, e);
        loopBody = this.parseBlock(inner, 0, inner.length).nodes;
        i = e + 1;
      }
    }
    return { node: { id: this.uid(), nodeKind: 'loop', loopHeader, loopBody }, end: i };
  }

  // ── Evaluation ─────────────────────────────────────────────────────────────

  private evalNode(node: FlowNode, values: Map<string, unknown>): EvaluatedNode {
    if (node.nodeKind === 'if') return this.evalIf(node, values);
    if (node.nodeKind === 'switch') return this.evalSwitch(node, values);
    return { id: node.id, nodeKind: node.nodeKind, text: node.text, loopHeader: node.loopHeader, takenBranchIdx: null, takenCaseIdx: null };
  }

  private evalIf(node: FlowNode, values: Map<string, unknown>): EvaluatedNode {
    const branches = node.branches ?? [];
    const evBranches: EvaluatedBranch[] = [];
    let takenIdx: number | null = null;
    let blocked = false; // a previous branch was taken

    for (let i = 0; i < branches.length; i++) {
      const br = branches[i];
      if (br.kind === 'else') {
        const taken = !blocked && takenIdx === null;
        evBranches.push({ ...br, result: blocked ? false : (takenIdx === null ? true : false), substituted: null, taken });
        if (taken) takenIdx = i;
        break;
      }
      const { boolResult, substituted } = this.evalBool(br.condition ?? '', values);
      if (boolResult === null) {
        evBranches.push({ ...br, result: null, substituted, taken: false });
        blocked = true; // can't determine downstream
      } else if (boolResult && !blocked) {
        evBranches.push({ ...br, result: true, substituted, taken: true });
        takenIdx = i; blocked = true;
      } else {
        evBranches.push({ ...br, result: false, substituted, taken: false });
      }
    }

    let subNodes: EvaluatedNode[] | undefined;
    if (takenIdx !== null) {
      subNodes = (branches[takenIdx].body).map(n => this.evalNode(n, values));
    }

    return { id: node.id, nodeKind: 'if', branches: evBranches, takenBranchIdx: takenIdx, takenCaseIdx: null, subNodes };
  }

  private evalSwitch(node: FlowNode, values: Map<string, unknown>): EvaluatedNode {
    const cases = node.cases ?? [];
    const { anyVal, substituted } = this.evalAny(node.switchExpr ?? '', values);
    let takenIdx: number | null = null;
    let defaultIdx: number | null = null;

    const evCases: EvaluatedCase[] = cases.map((c, i) => {
      if (c.isDefault) { defaultIdx = i; return { ...c, result: null, taken: false }; }
      if (anyVal === undefined) return { ...c, result: null, taken: false };
      try {
        // eslint-disable-next-line no-new-func
        const caseVal = new Function(`return (${c.label})`)();
        const match = anyVal === caseVal;
        if (match && takenIdx === null) takenIdx = i;
        return { ...c, result: match, taken: match };
      } catch {
        return { ...c, result: null, taken: false };
      }
    });

    if (takenIdx === null && defaultIdx !== null) {
      takenIdx = defaultIdx;
      if (evCases[defaultIdx]) evCases[defaultIdx].taken = true;
    }

    let subNodes: EvaluatedNode[] | undefined;
    if (takenIdx !== null) {
      subNodes = cases[takenIdx].body.map(n => this.evalNode(n, values));
    }

    return { id: node.id, nodeKind: 'switch', switchExpr: node.switchExpr, cases: evCases, takenBranchIdx: null, takenCaseIdx: takenIdx, subNodes };
  }

  // ── Condition / expression evaluation ─────────────────────────────────────

  private evalBool(expr: string, values: Map<string, unknown>): { boolResult: boolean | null; substituted: string } {
    const { anyVal, substituted } = this.evalAny(expr, values);
    return { boolResult: anyVal === undefined ? null : Boolean(anyVal), substituted };
  }

  private evalAny(expr: string, values: Map<string, unknown>): { anyVal: unknown; substituted: string } {
    if (!expr.trim()) return { anyVal: undefined, substituted: '' };
    let sub = expr;

    for (const [name, value] of values) {
      const json = JSON.stringify(value);
      // Replace this.name() — signal/model call
      sub = sub.replace(new RegExp(`\\bthis\\.${name}\\s*\\(\\)`, 'g'), json);
      // Replace this.name (not followed by word char or open paren)
      sub = sub.replace(new RegExp(`\\bthis\\.${name}(?![\\w(])`, 'g'), json);
    }

    // If unresolved this.xxx remain, we can't evaluate
    if (/\bthis\./.test(sub)) return { anyVal: undefined, substituted: sub };

    try {
      // eslint-disable-next-line no-new-func
      const result = new Function(`return (${sub})`)();
      return { anyVal: result, substituted: sub };
    } catch {
      return { anyVal: undefined, substituted: sub };
    }
  }

  // ── Input parsing ──────────────────────────────────────────────────────────

  private parseInputs(raw: Record<string, string>): Map<string, unknown> {
    const map = new Map<string, unknown>();
    for (const [k, v] of Object.entries(raw)) {
      if (v.trim() !== '') map.set(k, this.parseValue(v));
    }
    return map;
  }

  // ── Low-level text helpers ─────────────────────────────────────────────────

  private skipWS(s: string, i: number): number {
    while (i < s.length && /\s/.test(s[i])) i++;
    return i;
  }

  /** Match a keyword with word boundary. */
  private kw(s: string, i: number, word: string): boolean {
    return s.startsWith(word, i) && !/\w/.test(s[i + word.length] ?? '');
  }

  /** Skip past a string literal starting at i, returning the index after the closing quote. */
  private skipStr(s: string, i: number): number {
    const q = s[i]; i++;
    if (q === '`') {
      while (i < s.length && s[i] !== '`') {
        if (s[i] === '\\') i++;
        else if (s[i] === '$' && s[i + 1] === '{') {
          i += 2; let d = 1;
          while (i < s.length && d > 0) { if (s[i] === '{') d++; else if (s[i] === '}') d--; i++; }
          continue;
        }
        i++;
      }
    } else {
      while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
    }
    return i + 1;
  }

  /** Find the index of the matching `}` for the `{` at position start. */
  private closeBrace(s: string, start: number): number {
    let d = 1; let i = start + 1;
    while (i < s.length && d > 0) {
      const c = s[i];
      if (c === '{') d++;
      else if (c === '}') d--;
      else if (c === '"' || c === "'" || c === '`') { i = this.skipStr(s, i) - 1; }
      else if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; }
      else if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length - 1 && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; }
      i++;
    }
    return i - 1;
  }

  /** Extract content of balanced parens starting at position of `(`. */
  private extractParen(s: string, start: number): { content: string; end: number } {
    let d = 1; let i = start + 1;
    while (i < s.length && d > 0) {
      const c = s[i];
      if (c === '(') d++;
      else if (c === ')') { d--; if (d === 0) break; }
      else if (c === '"' || c === "'" || c === '`') { i = this.skipStr(s, i) - 1; }
      i++;
    }
    return { content: s.slice(start + 1, i), end: i };
  }

  /** Find end of a simple statement (semicolon, skipping strings and blocks). */
  private stmtEnd(s: string, from: number, limit: number): number {
    let i = from;
    while (i < limit) {
      const c = s[i];
      if (c === ';') return i;
      if (c === '{') { i = this.closeBrace(s, i) + 1; continue; }
      if (c === '"' || c === "'" || c === '`') { i = this.skipStr(s, i); continue; }
      i++;
    }
    return limit - 1;
  }

  private findCaseColon(s: string, from: number): number {
    let i = from;
    while (i < s.length) {
      const c = s[i];
      if (c === ':') return i;
      if (c === '"' || c === "'" || c === '`') { i = this.skipStr(s, i); continue; }
      i++;
    }
    return from;
  }

  private truncate(text: string, max: number): string {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max) + '…' : t;
  }
}
