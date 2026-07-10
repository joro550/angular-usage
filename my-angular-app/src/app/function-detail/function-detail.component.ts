import { Component, computed, inject, OnDestroy, signal } from '@angular/core';
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

// ─── Component ────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-function-detail',
  standalone: true,
  templateUrl: './function-detail.component.html',
})
export class FunctionDetailComponent implements OnDestroy {
  readonly state = inject(StateService);
  readonly parser = inject(FlowParserService);

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

  readonly hasSimValues = computed(() =>
    Object.values(this.simValues()).some(v => v.trim() !== ''),
  );

  readonly allBranchingPropsSet = computed(() => {
    const vals = this.simValues();
    return this.branchingProps().length > 0 &&
           this.branchingProps().every(p => (vals[p.prop.name] ?? '').trim() !== '');
  });

  /** Raw evaluated and flattened flow display items. */
  readonly displayItems = computed<FlowDisplayItem[]>(() => {
    const nodes = this.flowNodes();
    if (!nodes.length) return [];
    return this.parser.flatten(this.parser.evaluate(nodes, this.simValues()));
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

  // ── Timer ─────────────────────────────────────────────────────────────────

  private animTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnDestroy(): void { this.resetPlay(); }

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

  /** Substitute sim-values into an expression and try to evaluate it. */
  private evalExpression(expr: string): { substituted: string; value: string | null } {
    let sub = expr;
    const vals = this.simValues();
    const comp = this.comp();

    if (comp) {
      for (const prop of comp.properties) {
        const raw = vals[prop.name];
        if (!raw?.trim()) continue;
        const jsonVal = JSON.stringify(this.parser.parseValue(raw));
        sub = sub.replace(new RegExp(`\\bthis\\.${prop.name}\\s*\\(\\)`, 'g'), jsonVal);
        sub = sub.replace(new RegExp(`\\bthis\\.${prop.name}(?![\\w(])`, 'g'), jsonVal);
      }
    }

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

  onSimInput(name: string, event: Event): void {
    this.state.setSimValue(name, (event.target as HTMLInputElement).value);
  }

  clearSimValues(): void { this.state.clearSimValues(); }

  indentPx(depth: number): number { return depth * 20; }

  propKindColor(kind: PropertyKind): string {
    return PROP_COLORS[kind]?.text ?? '#94a3b8';
  }
}
