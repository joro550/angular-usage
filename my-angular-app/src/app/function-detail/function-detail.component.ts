import { Component, computed, inject, OnDestroy, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { MethodNode, ClassProperty, PropertyKind } from '../models/project.model';
import { StateService } from '../services/state.service';
import { FlowParserService, FlowDisplayItem } from '../services/flow-parser.service';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PropInfo {
  prop: ClassProperty;
  kind: PropertyKind;
  bg: string;
  text: string;
  inCondition: boolean;
}

interface ReturnResult {
  raw: string;
  substituted: string;
  value: string | null;
  isThrow: boolean;
}

interface CalledMethodCard { method: MethodNode; }

/** A field within an object-typed parameter or property. */
export interface ObjectField {
  name: string;
  type: string;
  inputKind: 'checkbox' | 'number' | 'text';
}

/** A single parsed parameter with its name and resolved TypeScript type. */
export interface ParsedParam {
  name: string;
  /** Raw TypeScript type string, e.g. "string", "number", "boolean", "User | null" */
  type: string;
  /** Whether this param appears in a branch condition in the method body. */
  inCondition: boolean;
  /** When the type is object-like, the known fields (may be empty for opaque named types). */
  isObject: boolean;
  fields: ObjectField[];
}

/** A property that may have been mutated during the simulated run. */
export interface MutatedProp {
  name: string;
  kind: PropertyKind;
  bg: string;
  text: string;
  /** The raw assignment expression found in the executed path. */
  assignExpr: string;
  /** Evaluated value after substitution, or null if not fully resolvable. */
  value: string | null;
  substituted: string;
}

export type DetailTab = 'overview' | 'flow';
type PlayState = 'idle' | 'playing' | 'done';

// ─── Colours ──────────────────────────────────────────────────────────────────

const PROP_COLORS: Record<PropertyKind, { bg: string; text: string }> = {
  signal:   { bg: 'rgba(34,197,94,0.15)',   text: '#4ade80' },
  computed: { bg: 'rgba(168,85,247,0.15)',  text: '#c084fc' },
  input:    { bg: 'rgba(59,130,246,0.15)',  text: '#60a5fa' },
  output:   { bg: 'rgba(249,115,22,0.15)',  text: '#fb923c' },
  model:    { bg: 'rgba(236,72,153,0.15)',  text: '#f472b6' },
  inject:   { bg: 'rgba(100,116,139,0.15)', text: '#94a3b8' },
  regular:  { bg: 'rgba(71,85,105,0.12)',   text: '#64748b' },
};

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Parse a raw TypeScript parameter string like:
 *   `userId: string, isActive: boolean, count: number = 0, options?: MyOptions`
 * into an array of { name, type } objects.
 *
 * Handles:
 *  - Simple types:  `name: string`
 *  - Union types:   `val: string | null`
 *  - Generic types: `items: Array<string>`
 *  - Optional:      `label?: string`  →  type becomes `string | undefined`
 *  - Rest params:   `...args: string[]`
 *  - Default vals:  `count: number = 0`  (default stripped, type kept)
 *  - Destructured:  `{ a, b }: Opts`    (kept as single opaque param "{ a, b }")
 *  - No annotation: `value`             (type becomes "unknown")
 */
function parseParamString(raw: string): { name: string; type: string }[] {
  const results: { name: string; type: string }[] = [];
  // Split on top-level commas (ignore commas inside <>, [], ())
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '<' || c === '(' || c === '[' || c === '{') { depth++; cur += c; }
    else if (c === '>' || c === ')' || c === ']' || c === '}') { depth--; cur += c; }
    else if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; }
    else { cur += c; }
  }
  if (cur.trim()) parts.push(cur.trim());

  for (const part of parts) {
    if (!part) continue;
    // Strip leading `...` for rest params
    const stripped = part.replace(/^\.{3}/, '').trim();
    // Find the colon that separates name from type (at depth 0)
    let colonIdx = -1;
    let d = 0;
    for (let i = 0; i < stripped.length; i++) {
      const c = stripped[i];
      if (c === '<' || c === '(' || c === '[' || c === '{') d++;
      else if (c === '>' || c === ')' || c === ']' || c === '}') d--;
      else if (c === ':' && d === 0) { colonIdx = i; break; }
    }

    let name: string;
    let rawType: string;
    const optional = stripped.includes('?');

    if (colonIdx === -1) {
      // No type annotation
      name = stripped.replace('?', '').trim();
      rawType = 'unknown';
    } else {
      name = stripped.slice(0, colonIdx).replace('?', '').trim();
      // Strip default value after `=` at depth 0
      const afterColon = stripped.slice(colonIdx + 1).trim();
      let eqIdx = -1;
      let d2 = 0;
      for (let i = 0; i < afterColon.length; i++) {
        const c = afterColon[i];
        if (c === '<' || c === '(' || c === '[' || c === '{') d2++;
        else if (c === '>' || c === ')' || c === ']' || c === '}') d2--;
        else if (c === '=' && d2 === 0) { eqIdx = i; break; }
      }
      rawType = (eqIdx === -1 ? afterColon : afterColon.slice(0, eqIdx)).trim();
    }

    if (optional && !rawType.includes('undefined')) {
      rawType = rawType ? `${rawType} | undefined` : 'undefined';
    }

    if (name) results.push({ name, type: rawType });
  }
  return results;
}

/** Map a TypeScript type string to a simple HTML input kind. */
function inputTypeFromString(typeStr: string): 'checkbox' | 'number' | 'text' {
  const t = typeStr.toLowerCase().trim();
  const parts = t.split('|').map(s => s.trim()).filter(s => s !== 'undefined' && s !== 'null');
  if (parts.length > 0 && parts.every(p => p === 'boolean')) return 'checkbox';
  if (parts.length > 0 && parts.every(p => p === 'number' || p === 'int' || p === 'float')) return 'number';
  return 'text';
}

/**
 * The set of TypeScript primitive / built-in type names that are NOT objects.
 * Anything not in this list and not an array/generic is treated as an object type.
 */
const SCALAR_TYPES = new Set([
  'string', 'number', 'boolean', 'bigint', 'symbol', 'any', 'unknown', 'never',
  'void', 'null', 'undefined', 'object', 'date', 'regexp', 'error', 'function',
]);

/**
 * Return true when a TypeScript type annotation represents an object/interface
 * (i.e. the user should fill in individual fields rather than a raw value).
 * Arrays, generics, and scalar types return false.
 */
function isObjectType(typeStr: string): boolean {
  // Strip nullability: `User | null | undefined` → `User`
  const parts = typeStr.split('|').map(s => s.trim()).filter(s => s !== 'null' && s !== 'undefined');
  if (parts.length === 0) return false;
  // If any part is an array or generic, treat as non-object (enter as JSON)
  for (const p of parts) {
    if (p.endsWith('[]') || p.includes('<') || p.includes('{')) continue;
    // PascalCase name that isn't a known scalar → object
    if (!/^[A-Z]/.test(p)) return false;
    if (SCALAR_TYPES.has(p.toLowerCase())) return false;
  }
  // Inline object literal type `{ prop: type; ... }`
  if (typeStr.trimStart().startsWith('{')) return true;
  // All parts are PascalCase non-scalar names
  return parts.every(p => /^[A-Z]/.test(p) && !SCALAR_TYPES.has(p.toLowerCase()));
}

/**
 * Parse an inline TypeScript object literal type like `{ id: number; name: string; active: boolean }`
 * into a list of ObjectField entries.  Returns [] for named/opaque types.
 */
function parseInlineObjectType(typeStr: string): ObjectField[] {
  const trimmed = typeStr.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return [];
  const inner = trimmed.slice(1, -1);
  const fields: ObjectField[] = [];
  // Split on `;` or `,` at depth 0
  const parts: string[] = [];
  let depth = 0, cur = '';
  for (const c of inner) {
    if (c === '<' || c === '(' || c === '[' || c === '{') { depth++; cur += c; }
    else if (c === '>' || c === ')' || c === ']' || c === '}') { depth--; cur += c; }
    else if ((c === ';' || c === ',') && depth === 0) { if (cur.trim()) parts.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  for (const part of parts) {
    const ci = part.indexOf(':');
    if (ci === -1) continue;
    const fname = part.slice(0, ci).replace('?', '').replace('readonly', '').trim();
    const ftype = part.slice(ci + 1).trim();
    if (fname) fields.push({ name: fname, type: ftype, inputKind: inputTypeFromString(ftype) });
  }
  return fields;
}

/**
 * Try to reconstruct a plain object from dot-notation field entries in `vals`.
 * Returns the object if at least one field has a value, null otherwise.
 * Field entries use keys like "paramName.fieldName".
 * When `fields` is empty (opaque named type), check for a "paramName" JSON entry.
 */
function buildObjectFromFields(
  name: string,
  fields: ObjectField[],
  vals: Record<string, string>,
): Record<string, unknown> | null {
  if (fields.length === 0) return null; // opaque — no expansion
  const obj: Record<string, unknown> = {};
  let anySet = false;
  for (const f of fields) {
    const key = `${name}.${f.name}`;
    const raw = vals[key];
    if (!raw?.trim()) continue;
    anySet = true;
    const t = raw.trim();
    if (t === 'true') obj[f.name] = true;
    else if (t === 'false') obj[f.name] = false;
    else if (!isNaN(Number(t))) obj[f.name] = Number(t);
    else { try { obj[f.name] = JSON.parse(t); } catch { obj[f.name] = t; } }
  }
  return anySet ? obj : null;
}

// ─── Eval sandbox ────────────────────────────────────────────────────────────

/** Returned by stubs when a `this` access could not be resolved. */
const EVAL_STUB: unique symbol = Symbol('eval_stub');

/**
 * Builds a Proxy for `this` inside the sandboxed evaluator.
 *
 * - Known names (in `base`) are returned as-is, wrapped so they can be
 *   called as zero-arg functions (signal pattern: `this.count()`) AND
 *   have their own properties accessible (`this.user.name`).
 * - Unknown names return a recursive stub so property/method chains on
 *   unresolved values don't throw — they just return EVAL_STUB.
 */
function buildThisProxy(base: Record<string, unknown>): unknown {
  function wrapValue(v: unknown): unknown {
    if (v === null || v === undefined) {
      const fn = (): unknown => v;
      return new Proxy(fn as unknown as Record<string, unknown>, valueHandler(v));
    }
    if (typeof v === 'function') return v;
    if (typeof v === 'object') {
      // Real object — make it callable as zero-arg getter AND forward property access
      const fn = (): unknown => v;
      return new Proxy(fn as unknown as Record<string, unknown>, valueHandler(v));
    }
    // Primitive: wrap as callable
    const fn = (): unknown => v;
    return new Proxy(fn as unknown as Record<string, unknown>, valueHandler(v));
  }

  function valueHandler(v: unknown): ProxyHandler<Record<string, unknown>> {
    return {
      get(_t, prop) {
        if (typeof prop === 'symbol') {
          if (prop === Symbol.toPrimitive) return () => v;
          if (prop === Symbol.iterator && Array.isArray(v))
            return (v as unknown[])[Symbol.iterator].bind(v);
          return undefined;
        }
        if (v !== null && v !== undefined && typeof v === 'object') {
          const obj = v as Record<string, unknown>;
          if (prop in obj) {
            const child = obj[prop];
            return typeof child === 'function'
              ? (child as (...a: unknown[]) => unknown).bind(obj)
              : wrapValue(child);
          }
          // Array / built-in methods
          if (Array.isArray(v)) {
            const arr = v as unknown[];
            const method = (arr as unknown as Record<string, unknown>)[prop];
            if (typeof method === 'function')
              return (method as (...a: unknown[]) => unknown).bind(arr);
          }
        }
        if (typeof v === 'string') {
          const proto = String.prototype as unknown as Record<string, unknown>;
          if (typeof proto[prop as string] === 'function')
            return (proto[prop as string] as (...a: unknown[]) => unknown).bind(v);
        }
        // Unknown property on a known value — return stub
        return stubFn();
      },
      apply(_t, _ctx, args): unknown {
        return args.length === 0 ? v : v;
      },
    };
  }

  function stubFn(): unknown {
    const fn = (): typeof EVAL_STUB => EVAL_STUB;
    return new Proxy(fn as unknown as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return () => undefined;
        return stubFn();
      },
      apply(): typeof EVAL_STUB { return EVAL_STUB; },
    });
  }

  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop === 'symbol') return undefined;
      const key = prop as string;
      if (key in target) return wrapValue(target[key]);
      return stubFn(); // unknown this.xxx — return stub, not throw
    },
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-function-detail',
  standalone: true,
  templateUrl: './function-detail.component.html',
})
export class FunctionDetailComponent implements OnDestroy {
  readonly state    = inject(StateService);
  readonly parser   = inject(FlowParserService);
  private sanitizer = inject(DomSanitizer);

  readonly method = computed(() => this.state.selectedMethod()!);
  readonly comp   = computed(() => this.state.selectedComponent());

  readonly activeTab = signal<DetailTab>('overview');

  // ── Parsed flow tree (shared by both tabs) ────────────────────────────────

  readonly flowNodes = computed(() => {
    const body = this.method().body;
    return body?.trim() ? this.parser.parse(body) : [];
  });

  readonly conditionPropNames = computed<Set<string>>(() =>
    this.parser.extractConditionProps(this.flowNodes()),
  );

  // ── Overview tab ──────────────────────────────────────────────────────────

  readonly calledMethodCards = computed<CalledMethodCard[]>(() => {
    const method = this.method();
    const comp = this.comp();
    if (!comp) return [];
    return method.calledMethods
      .map(name => comp.methods.find(m => m.name === name))
      .filter(Boolean)
      .map(m => ({ method: m! }));
  });

  readonly propChips = computed<PropInfo[]>(() => {
    const method = this.method();
    const comp = this.comp();
    if (!comp) return [];
    const condNames = this.conditionPropNames();
    return method.touchedProperties
      .map(name => {
        const prop = comp.properties.find(p => p.name === name);
        if (!prop) return null;
        const colors = PROP_COLORS[prop.kind] ?? PROP_COLORS['regular'];
        return { prop, kind: prop.kind, ...colors, inCondition: condNames.has(name) } as PropInfo;
      })
      .filter(Boolean)
      .sort((a, b) => (b!.inCondition ? 1 : 0) - (a!.inCondition ? 1 : 0)) as PropInfo[];
  });

  // ── Flow / simulation tab ─────────────────────────────────────────────────

  readonly simValues = this.state.simulationValues;

  /** Parsed parameter list for the current method. */
  readonly parsedParams = computed<ParsedParam[]>(() => {
    const raw = this.method().params?.trim();
    if (!raw) return [];
    const paramCondNames = this.parser.extractParamConditionNames(this.flowNodes());
    return parseParamString(raw).map(p => {
      const obj = isObjectType(p.type);
      const fields = obj ? parseInlineObjectType(p.type) : [];
      return { ...p, inCondition: paramCondNames.has(p.name), isObject: obj, fields };
    });
  });

  readonly branchingParams = computed<ParsedParam[]>(() =>
    this.parsedParams().filter(p => p.inCondition),
  );
  readonly accessOnlyParams = computed<ParsedParam[]>(() =>
    this.parsedParams().filter(p => !p.inCondition),
  );

  /**
   * Merged param values + sim values + mock returns — used for all evaluation.
   * For object params, also injects a synthetic JSON key for the whole object
   * built from the dot-notation field entries ("param.field" keys).
   */
  readonly allInputValues = computed<Record<string, string>>(() => {
    const base: Record<string, string> = {
      ...this.state.paramValues(),
      ...this.state.simulationValues(),
      ...this.state.mockReturnValues(),
    };
    // Reconstruct full object values from dot-notation field entries
    for (const param of this.parsedParams()) {
      if (!param.isObject) continue;
      const obj = buildObjectFromFields(param.name, param.fields, base);
      if (obj !== null) base[param.name] = JSON.stringify(obj);
    }
    // Same for object-typed class properties
    const comp = this.comp();
    if (comp) {
      for (const prop of comp.properties) {
        if (!prop.dataType || !isObjectType(prop.dataType)) continue;
        const fields = parseInlineObjectType(prop.dataType);
        const obj = buildObjectFromFields(prop.name, fields, base);
        if (obj !== null) base[prop.name] = JSON.stringify(obj);
      }
    }
    return base;
  });

  readonly simProps = computed<PropInfo[]>(() => {
    const comp = this.comp();
    if (!comp) return [];
    const condNames = this.conditionPropNames();
    return this.method().touchedProperties
      .map(name => {
        const prop = comp.properties.find(p => p.name === name);
        if (!prop) return null;
        const colors = PROP_COLORS[prop.kind] ?? PROP_COLORS['regular'];
        return { prop, kind: prop.kind, ...colors, inCondition: condNames.has(name) } as PropInfo;
      })
      .filter(Boolean)
      .sort((a, b) => (b!.inCondition ? 1 : 0) - (a!.inCondition ? 1 : 0)) as PropInfo[];
  });

  readonly branchingProps  = computed<PropInfo[]>(() => this.simProps().filter(p => p.inCondition));
  readonly accessOnlyProps = computed<PropInfo[]>(() => this.simProps().filter(p => !p.inCondition));

  // ── Method parameters and local variables ───────────────────────────────

  /** Names of formal parameters declared in the method signature. */
  readonly methodParamNames = computed<string[]>(() =>
    this.parser.parseMethodParamNames(this.method().params),
  );

  /** const / let / var declarations found in the method body. */
  readonly localDecls = computed<{ name: string; initExpr: string }[]>(() => {
    const body = this.method().body;
    return body ? this.parser.extractLocalDeclarations(body) : [];
  });

  /**
   * Bare identifiers (NOT `this.xxx`) that appear in branching conditions.
   * These are candidates for mocking — e.g. `result` in `if (result.ok)`
   * where `result` came from a local `const result = await this.api.get()`.
   */
  readonly bareConditionIdents = computed<Set<string>>(() =>
    this.parser.extractParamConditionNames(this.flowNodes()),
  );

  /**
   * Combined list of method params + local vars that are worth offering as
   * mock inputs. Sorted so condition-relevant items appear first.
   */
  readonly mockableLocals = computed<{
    name: string;
    initExpr?: string;
    isParam: boolean;
    inCondition: boolean;
  }[]>(() => {
    const paramNames = new Set(this.methodParamNames());
    const condIdents  = this.bareConditionIdents();
    const classProps  = new Set((this.comp()?.properties ?? []).map(p => p.name));
    const seen = new Set<string>();
    const result: { name: string; initExpr?: string; isParam: boolean; inCondition: boolean }[] = [];

    // Method parameters
    for (const name of paramNames) {
      if (seen.has(name) || classProps.has(name)) continue;
      seen.add(name);
      result.push({ name, isParam: true, inCondition: condIdents.has(name) });
    }
    // Local variable declarations
    for (const decl of this.localDecls()) {
      if (seen.has(decl.name) || classProps.has(decl.name)) continue;
      seen.add(decl.name);
      result.push({ name: decl.name, initExpr: decl.initExpr, isParam: false, inCondition: condIdents.has(decl.name) });
    }
    return result.sort((a, b) => (b.inCondition ? 1 : 0) - (a.inCondition ? 1 : 0));
  });

  // ── Result detail panel ───────────────────────────────────────────────────

  /** Toggle the expanded value-snapshot panel on the result card. */
  readonly showResultDetail = signal(false);

  /**
   * Snapshot of every mocked value in play at the end of the simulation.
   * Used to display the full class / local state when the user clicks the result.
   */
  readonly allValueSnapshot = computed<{ name: string; raw: string; kind: 'prop' | 'param' | 'local' }[]>(() => {
    const vals = this.simValues();
    const comp = this.comp();
    const out: { name: string; raw: string; kind: 'prop' | 'param' | 'local' }[] = [];

    for (const prop of comp?.properties ?? []) {
      const v = vals[prop.name];
      if (v?.trim()) out.push({ name: prop.name, raw: v.trim(), kind: 'prop' });
    }
    for (const local of this.mockableLocals()) {
      const v = vals[local.name];
      if (v?.trim()) out.push({ name: local.name, raw: v.trim(), kind: local.isParam ? 'param' : 'local' });
    }
    return out;
  });

  readonly hasSimValues = computed(() =>
    Object.values(this.allInputValues()).some(v => v.trim() !== ''),
  );

  readonly allBranchingPropsSet = computed(() => {
    const vals = this.allInputValues();
    const propsOk = this.branchingProps().length === 0 ||
      this.branchingProps().every(p => (vals[p.prop.name] ?? '').trim() !== '');
    const paramsOk = this.branchingParams().length === 0 ||
      this.branchingParams().every(p => (vals[p.name] ?? '').trim() !== '');
    return (this.branchingProps().length > 0 || this.branchingParams().length > 0)
      && propsOk && paramsOk;
  });

  /** Raw evaluated and flattened flow display items. */
  readonly displayItems = computed<FlowDisplayItem[]>(() => {
    const nodes = this.flowNodes();
    if (!nodes.length) return [];
    return this.parser.flatten(this.parser.evaluate(nodes, this.allInputValues()));
  });

  readonly resolvedBranches = computed(() =>
    this.displayItems().filter(i => i.type === 'if-head' && i.result !== null).length,
  );

  readonly totalBranches = computed(() =>
    this.displayItems().filter(i => i.type === 'if-head' && !i.isElse).length,
  );

  // ── Execution path ─────────────────────────────────────────────────────────

  /**
   * Ordered indices into displayItems() that the code would actually visit.
   * Skips branches with `taken = false`, and stops at the first return/throw
   * because subsequent statements are unreachable.
   */
  readonly executionPath = computed<number[]>(() => {
    const items = this.displayItems();
    const path: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.taken === false) continue;
      path.push(i);
      if (item.type === 'return' || item.type === 'throw') break;
    }
    return path;
  });

  readonly executionPathSet = computed<Set<number>>(() => new Set(this.executionPath()));

  // ── Animation state ────────────────────────────────────────────────────────

  readonly playState     = signal<PlayState>('idle');
  readonly activeStepIdx = signal(-1);

  /** The displayItems() index that is currently highlighted. */
  readonly activeDisplayIdx = computed(() => {
    const step = this.activeStepIdx();
    const path = this.executionPath();
    return step >= 0 && step < path.length ? path[step] : -1;
  });

  /** All displayItems() indices that the dot has already passed through. */
  readonly visitedDisplayIdxs = computed<Set<number>>(() => {
    const step = this.activeStepIdx();
    const path = this.executionPath();
    if (step < 0) return new Set();
    return new Set(path.slice(0, step + 1));
  });

  /** 0-100 progress percentage for the guide-line fill. */
  readonly animProgressPct = computed(() => {
    const activeIdx = this.activeDisplayIdx();
    const total = this.displayItems().length;
    return activeIdx >= 0 && total > 0 ? ((activeIdx + 1) / total) * 100 : 0;
  });

  // ── Return / throw result ──────────────────────────────────────────────────

  readonly returnResult = computed<ReturnResult | null>(() => {
    const items = this.displayItems();
    const path  = this.executionPath();
    if (!path.length) return null;

    const last = items[path[path.length - 1]];
    if (last?.type !== 'return' && last?.type !== 'throw') return null;

    const isThrow = last.type === 'throw';
    const raw = last.text ?? '';
    const expr = raw.replace(/^return\s*/, '').replace(/^throw\s*/, '').replace(/;$/, '').trim();

    if (!expr) return { raw, substituted: 'undefined', value: 'undefined', isThrow };

    const { substituted, value } = this.evalExpression(expr);
    return { raw, substituted, value, isThrow };
  });

  // ── Post-run state snapshot ──────────────────────────────────────────────

  /**
   * Scan every code statement in the executed path for `this.propName = expr`
   * assignments and evaluate what the property would be after the run.
   * Only reports properties listed in touchedProperties for the method.
   */
  readonly mutatedProps = computed<MutatedProp[]>(() => {
    const items = this.displayItems();
    const path  = this.executionPath();
    const comp  = this.comp();
    if (!path.length || !comp) return [];

    // Pattern: `this.propName = expr` or `this.propName.set(expr)` (signal setter)
    const assignRe  = /\bthis\.(\w+)\s*=(?!=)(.+?)(?:;|$)/;
    const setterRe  = /\bthis\.(\w+)\.set\((.+?)\)\s*;?\s*$/;
    const updateRe  = /\bthis\.(\w+)\.update\(/;          // too complex to eval, just flag it

    // Last-write wins: collect final value per property name
    const lastWrite = new Map<string, { expr: string; kind: 'assign' | 'set' | 'update' }>();

    for (const idx of path) {
      const item = items[idx];
      if (item.type !== 'code') continue;
      const text = item.text ?? '';

      const sa = assignRe.exec(text);
      if (sa) { lastWrite.set(sa[1], { expr: sa[2].trim(), kind: 'assign' }); continue; }

      const ss = setterRe.exec(text);
      if (ss) { lastWrite.set(ss[1], { expr: ss[2].trim(), kind: 'set' }); continue; }

      if (updateRe.test(text)) {
        const um = /\bthis\.(\w+)\.update\(/.exec(text);
        if (um) lastWrite.set(um[1], { expr: '(computed via .update())', kind: 'update' });
      }
    }

    if (lastWrite.size === 0) return [];

    const results: MutatedProp[] = [];
    for (const [propName, { expr, kind }] of lastWrite) {
      const prop = comp.properties.find(p => p.name === propName);
      const colors = PROP_COLORS[prop?.kind ?? 'regular'] ?? PROP_COLORS['regular'];
      let value: string | null = null;
      let substituted = expr;
      if (kind !== 'update') {
        const ev = this.evalExpression(expr);
        value = ev.value;
        substituted = ev.substituted;
      }
      results.push({
        name: propName,
        kind: prop?.kind ?? 'regular',
        bg: colors.bg,
        text: colors.text,
        assignExpr: expr,
        value,
        substituted,
      });
    }
    return results;
  });

  // ── Timer ─────────────────────────────────────────────────────────────────

  private animTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnDestroy(): void { this.resetPlay(); }

  /** Call when navigating to a new method so stale UI state is cleared. */
  private resetUiState(): void {
    this.resetPlay();
    this.showResultDetail.set(false);
  }

  // ── Play controls ─────────────────────────────────────────────────────────

  play(): void {
    if (this.playState() === 'playing') return;
    if (this.playState() === 'done') this.resetPlay();
    this.playState.set('playing');
    this.scheduleNext();
  }

  stepForward(): void {
    if (this.animTimer) { clearTimeout(this.animTimer); this.animTimer = null; }
    if (this.playState() !== 'playing') this.playState.set('playing');
    const next = this.activeStepIdx() + 1;
    if (next >= this.executionPath().length) {
      // Clamp to last
      this.activeStepIdx.set(Math.max(0, this.executionPath().length - 1));
      this.playState.set('done');
      return;
    }
    this.activeStepIdx.set(next);
    this.scrollToActive();
  }

  resetPlay(): void {
    if (this.animTimer) { clearTimeout(this.animTimer); this.animTimer = null; }
    this.playState.set('idle');
    this.activeStepIdx.set(-1);
  }

  // ── Private animation helpers ─────────────────────────────────────────────

  private scheduleNext(): void {
    const next = this.activeStepIdx() + 1;
    if (next >= this.executionPath().length) {
      this.playState.set('done');
      return;
    }
    this.activeStepIdx.set(next);
    this.scrollToActive();

    const item = this.displayItems()[this.executionPath()[next]];
    const delay = this.stepMs(item);
    this.animTimer = setTimeout(() => {
      if (this.playState() === 'playing') this.scheduleNext();
    }, delay);
  }

  private stepMs(item: FlowDisplayItem): number {
    if (item.type === 'if-head')    return item.result !== null ? 800 : 500;
    if (item.type === 'return' || item.type === 'throw') return 700;
    if (item.type === 'switch-head') return 550;
    if (item.type === 'switch-case') return 450;
    if (item.type === 'loop')        return 450;
    return 330;
  }

  private scrollToActive(): void {
    if (typeof document === 'undefined') return;
    const idx = this.activeDisplayIdx();
    if (idx < 0) return;
    setTimeout(() => {
      document.querySelector(`[data-flow-idx="${idx}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 60);
  }

  /** Evaluate an expression using variable injection so object/method chains work correctly. */
  private evalExpression(expr: string): { substituted: string; value: string | null } {
    const vals = this.allInputValues();
    const comp = this.comp();
    const mockReturns = this.state.mockReturnValues();

    // ── Build a display-only substituted string (for the UI label) ───────────
    let sub = expr;
    for (const param of this.parsedParams()) {
      const raw = vals[param.name];
      if (!raw?.trim()) continue;
      const j = JSON.stringify(this.parser.parseValue(raw));
      sub = sub.replace(new RegExp(`(?<![.\\w])\\b${param.name}\\b(?![\\w.])`, 'g'), j);
    }
    if (comp) {
      for (const prop of comp.properties) {
        const raw = vals[prop.name];
        if (!raw?.trim()) continue;
        const j = JSON.stringify(this.parser.parseValue(raw));
        sub = sub.replace(new RegExp(`\\bthis\.${prop.name}\\s*\\(\\)`, 'g'), j);
        sub = sub.replace(new RegExp(`\\bthis\.${prop.name}(?![\\w.(])`, 'g'), j);
      }
      for (const method of comp.methods) {
        const raw = mockReturns[method.name];
        if (!raw?.trim()) continue;
        const j = JSON.stringify(this.parser.parseValue(raw));
        sub = sub.replace(new RegExp(`\\bthis\.${method.name}\\s*\\([^)]*\\)`, 'g'), j);
      }
    }

    // ── Build variable-injection scope ───────────────────────────────────────────
    const varNames: string[] = [];
    const varValues: unknown[] = [];

    // Bare param names
    for (const param of this.parsedParams()) {
      const raw = vals[param.name];
      if (!raw?.trim()) continue;
      varNames.push(param.name);
      varValues.push(this.parser.parseValue(raw));
    }

    // Build the `_this` proxy object
    const thisObj: Record<string, unknown> = {};
    if (comp) {
      for (const prop of comp.properties) {
        const raw = vals[prop.name];
        if (raw?.trim()) thisObj[prop.name] = this.parser.parseValue(raw);
      }
      for (const method of comp.methods) {
        const raw = mockReturns[method.name];
        if (raw?.trim()) {
          const v = this.parser.parseValue(raw);
          thisObj[method.name] = () => v;
        }
      }
    }

    try {
      const paramDecls = varNames.map((n, i) => `var ${n} = __args[${i}];`).join(' ');
      // Rewrite `this.xxx` → `__t.xxx` so the proxy intercepts all this-accesses
      const rewritten = expr.replace(/\bthis\./g, '__t.');
      // eslint-disable-next-line no-new-func
      const fn = new Function('__t', '__args', `${paramDecls} return (${rewritten});`);
      const thisProxy = buildThisProxy(thisObj);
      const result = fn(thisProxy, varValues);
      if (result === EVAL_STUB) {
        // Unknown this-access — fall through to substituted display
        return { substituted: sub, value: null };
      }
      const value =
        result === undefined ? 'undefined'
        : result === null ? 'null'
        : typeof result === 'object' ? JSON.stringify(result)
        : String(result);
      return { substituted: sub, value };
    } catch {
      // Fallback: plain substituted eval
      if (/\bthis\./.test(sub)) return { substituted: sub, value: null };
      try {
        // eslint-disable-next-line no-new-func
        const result = new Function(`return (${sub})`)();
        const value =
          result === undefined ? 'undefined'
          : result === null ? 'null'
          : typeof result === 'object' ? JSON.stringify(result)
          : String(result);
        return { substituted: sub, value };
      } catch {
        return { substituted: sub, value: null };
      }
    }
  }

  // ── Shared helpers ────────────────────────────────────────────────────────

  navigateToMethod(method: MethodNode): void { this.state.selectMethod(method); }

  getMethodAccent(method: MethodNode): string {
    if (method.isLifecycle) return 'linear-gradient(90deg,#f59e0b,#fbbf24)';
    if (method.isAsync)     return 'linear-gradient(90deg,#3b82f6,#6366f1)';
    return 'linear-gradient(90deg,#6366f1,#8b5cf6)';
  }

  getFormattedBody(): string {
    const body = this.method().body;
    if (!body) return '// (no body detected)';
    const t = body.trim();
    return t.length > 1500 ? t.slice(0, 1500) + '\n// … (truncated)' : t;
  }

  /** Highlighted method body for the Overview tab. */
  readonly highlightedBody = computed<SafeHtml>(() =>
    this.sanitizer.bypassSecurityTrustHtml(this.highlightTypeScript(this.getFormattedBody()))
  );

  /**
   * Minimal TypeScript syntax highlighter using a char-by-char scanner.
   * Returns an HTML string with <span class="syn-*"> wrapping.
   */
  highlightTypeScript(code: string): string {
    const KW = new Set([
      'if','else','return','throw','try','catch','finally',
      'const','let','var','for','while','do','switch','case','default',
      'break','continue','new','typeof','instanceof','async','await',
      'function','class','import','export','from','of','in',
      'true','false','null','undefined',
    ]);

    const OPERATORS = ['===','!==','=>','==','!=','>=','<=','&&','||','??','?.'];

    function esc(s: string): string {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function span(cls: string, content: string): string {
      return `<span class="${cls}">${content}</span>`;
    }

    let out = '';
    let i = 0;
    const len = code.length;

    while (i < len) {
      const ch = code[i];

      // ── Line comment
      if (ch === '/' && code[i + 1] === '/') {
        let end = i;
        while (end < len && code[end] !== '\n') end++;
        out += span('syn-cmt', esc(code.slice(i, end)));
        i = end;
        continue;
      }

      // ── Block comment
      if (ch === '/' && code[i + 1] === '*') {
        let end = i + 2;
        while (end < len - 1 && !(code[end] === '*' && code[end + 1] === '/')) end++;
        end += 2; // include closing */
        out += span('syn-cmt', esc(code.slice(i, end)));
        i = end;
        continue;
      }

      // ── String / template literal
      if (ch === '"' || ch === "'" || ch === '`') {
        const q = ch;
        let j = i + 1;
        let raw = q;
        if (q === '`') {
          // template literal — scan carefully, handle ${...}
          while (j < len && code[j] !== '`') {
            if (code[j] === '\\') { raw += code[j] + (code[j + 1] ?? ''); j += 2; continue; }
            if (code[j] === '$' && code[j + 1] === '{') {
              raw += '${'; j += 2;
              let d = 1;
              while (j < len && d > 0) {
                if (code[j] === '{') d++;
                else if (code[j] === '}') d--;
                raw += code[j]; j++;
              }
              continue;
            }
            raw += code[j]; j++;
          }
          raw += code[j] ?? ''; j++;
        } else {
          while (j < len && code[j] !== q) {
            if (code[j] === '\\') { raw += code[j] + (code[j + 1] ?? ''); j += 2; continue; }
            raw += code[j]; j++;
          }
          raw += code[j] ?? ''; j++;
        }
        out += span('syn-str', esc(raw));
        i = j;
        continue;
      }

      // ── Number
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(code[i + 1] ?? ''))) {
        let j = i;
        while (j < len && /[0-9a-fA-FxX_.]/.test(code[j])) j++;
        out += span('syn-num', esc(code.slice(i, j)));
        i = j;
        continue;
      }

      // ── Operators (multi-char first)
      let matched = false;
      for (const op of OPERATORS) {
        if (code.startsWith(op, i)) {
          out += span('syn-op', esc(op));
          i += op.length;
          matched = true;
          break;
        }
      }
      if (matched) continue;

      // ── Identifier (keyword / function call / this)
      if (/[a-zA-Z_$]/.test(ch)) {
        let j = i;
        while (j < len && /[\w$]/.test(code[j])) j++;
        const word = code.slice(i, j);

        // skip whitespace to detect function call
        let k = j;
        while (k < len && (code[k] === ' ' || code[k] === '\t')) k++;
        const isFnCall = code[k] === '(';

        if (word === 'this') {
          out += span('syn-this', 'this');
        } else if (KW.has(word)) {
          out += span('syn-kw', esc(word));
        } else if (isFnCall) {
          out += span('syn-fn', esc(word));
        } else {
          out += esc(word);
        }
        i = j;
        continue;
      }

      // ── Everything else (punctuation, whitespace, newlines)
      out += esc(ch);
      i++;
    }

    return out;
  }

  onSimInput(name: string, event: Event): void {
    this.state.setSimValue(name, (event.target as HTMLInputElement).value);
  }

  onSimCheckbox(name: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.state.setSimValue(name, checked ? 'true' : 'false');
  }

  onParamInput(name: string, event: Event): void {
    this.state.setParamValue(name, (event.target as HTMLInputElement).value);
  }

  onParamCheckbox(name: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.state.setParamValue(name, checked ? 'true' : 'false');
  }

  onMockReturnInput(methodName: string, event: Event): void {
    this.state.setMockReturn(methodName, (event.target as HTMLInputElement).value);
  }

  getInputType(prop: ClassProperty): 'checkbox' | 'number' | 'text' {
    return inputTypeFromString(prop.dataType ?? '');
  }

  getParamInputType(param: ParsedParam): 'checkbox' | 'number' | 'text' {
    return inputTypeFromString(param.type);
  }

  getCheckedValue(name: string): boolean {
    const v = this.simValues()[name] ?? '';
    return v === 'true' || v === '1';
  }

  getParamCheckedValue(name: string): boolean {
    const v = this.state.paramValues()[name] ?? '';
    return v === 'true' || v === '1';
  }

  /** Get the stored value for an object param field (keyed as "paramName.fieldName"). */
  getParamFieldValue(paramName: string, fieldName: string): string {
    return this.state.paramValues()[`${paramName}.${fieldName}`] ?? '';
  }

  getParamFieldChecked(paramName: string, fieldName: string): boolean {
    const v = this.getParamFieldValue(paramName, fieldName);
    return v === 'true' || v === '1';
  }

  onParamFieldInput(paramName: string, fieldName: string, event: Event): void {
    this.state.setParamValue(`${paramName}.${fieldName}`, (event.target as HTMLInputElement).value);
  }

  onParamFieldCheckbox(paramName: string, fieldName: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.state.setParamValue(`${paramName}.${fieldName}`, checked ? 'true' : 'false');
  }

  /** Get the stored value for an object property field (keyed as "propName.fieldName"). */
  getSimFieldValue(propName: string, fieldName: string): string {
    return this.state.simulationValues()[`${propName}.${fieldName}`] ?? '';
  }

  getSimFieldChecked(propName: string, fieldName: string): boolean {
    const v = this.getSimFieldValue(propName, fieldName);
    return v === 'true' || v === '1';
  }

  onSimFieldInput(propName: string, fieldName: string, event: Event): void {
    this.state.setSimValue(`${propName}.${fieldName}`, (event.target as HTMLInputElement).value);
  }

  onSimFieldCheckbox(propName: string, fieldName: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.state.setSimValue(`${propName}.${fieldName}`, checked ? 'true' : 'false');
  }

  /** Whether a class property has an object type with known inline fields. */
  getPropFields(prop: ClassProperty): ObjectField[] {
    if (!prop.dataType || !isObjectType(prop.dataType)) return [];
    return parseInlineObjectType(prop.dataType);
  }

  clearSimValues(): void {
    this.state.clearParamValues();
    this.state.clearSimValues();
    this.state.clearMockReturns();
  }

  indentPx(depth: number): number { return depth * 20; }

  propKindColor(kind: PropertyKind): string {
    return PROP_COLORS[kind]?.text ?? '#94a3b8';
  }

  // ── Computed property dep drill-down ────────────────────────────────────────

  readonly expandedComputedProp = signal<string | null>(null);

  toggleComputedProp(name: string): void {
    this.expandedComputedProp.update(cur => cur === name ? null : name);
  }

  getComputedDeps(prop: ClassProperty): Array<{ name: string; kind: PropertyKind; bg: string; text: string }> {
    if (prop.kind !== 'computed' || !prop.computedBody) return [];
    const comp = this.comp();
    if (!comp) return [];
    const propMap = new Map(comp.properties.map(p => [p.name, p]));
    const deps: Array<{ name: string; kind: PropertyKind; bg: string; text: string }> = [];
    const seen = new Set<string>();
    const pat = /\bthis\.(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(prop.computedBody)) !== null) {
      const name = m[1];
      if (seen.has(name) || !propMap.has(name)) continue;
      seen.add(name);
      const dep = propMap.get(name)!;
      const colors = PROP_COLORS[dep.kind] ?? PROP_COLORS['regular'];
      deps.push({ name, kind: dep.kind, bg: colors.bg, text: colors.text });
    }
    return deps;
  }
}
