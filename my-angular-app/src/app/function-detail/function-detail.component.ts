import { Component, computed, inject, signal } from '@angular/core';
import { MethodNode, ClassProperty, PropertyKind } from '../models/project.model';
import { StateService } from '../services/state.service';
import { FlowParserService, FlowDisplayItem } from '../services/flow-parser.service';

// Unified property info used by both the overview and flow tabs
export interface PropInfo {
  prop: ClassProperty;
  kind: PropertyKind;
  bg: string;
  text: string;
  /** True when this property appears in an if/switch/ternary/loop condition. */
  inCondition: boolean;
}

interface CalledMethodCard {
  method: MethodNode;
}

const PROP_COLORS: Record<PropertyKind, { bg: string; text: string }> = {
  signal:   { bg: 'rgba(34,197,94,0.15)',   text: '#4ade80' },
  computed: { bg: 'rgba(168,85,247,0.15)',  text: '#c084fc' },
  input:    { bg: 'rgba(59,130,246,0.15)',  text: '#60a5fa' },
  output:   { bg: 'rgba(249,115,22,0.15)',  text: '#fb923c' },
  model:    { bg: 'rgba(236,72,153,0.15)',  text: '#f472b6' },
  inject:   { bg: 'rgba(100,116,139,0.15)', text: '#94a3b8' },
  regular:  { bg: 'rgba(71,85,105,0.12)',   text: '#64748b' },
};

export type DetailTab = 'overview' | 'flow';

@Component({
  selector: 'app-function-detail',
  standalone: true,
  templateUrl: './function-detail.component.html',
})
export class FunctionDetailComponent {
  readonly state = inject(StateService);
  private readonly parser = inject(FlowParserService);

  readonly method = computed(() => this.state.selectedMethod()!);
  readonly comp = computed(() => this.state.selectedComponent());

  readonly activeTab = signal<DetailTab>('overview');

  // ── Parsed flow tree (shared by both tabs) ────────────────────────────────

  readonly flowNodes = computed(() => {
    const body = this.method().body;
    return body?.trim() ? this.parser.parse(body) : [];
  });

  /**
   * Set of property names that appear inside branching conditions —
   * if/else-if expressions, switch discriminants, ternary conditions, loop guards.
   * Only these properties actually change which code path executes.
   */
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

  /**
   * All class properties this method touches, annotated with whether each
   * one appears in a branching condition.
   */
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
        return {
          prop,
          kind: prop.kind,
          bg: colors.bg,
          text: colors.text,
          inCondition: condNames.has(name),
        } as PropInfo;
      })
      .filter(Boolean)
      // Branching properties shown first
      .sort((a, b) => (b!.inCondition ? 1 : 0) - (a!.inCondition ? 1 : 0)) as PropInfo[];
  });

  // ── Flow / simulation tab ─────────────────────────────────────────────────

  readonly simValues = this.state.simulationValues;

  /**
   * All touched properties, annotated and sorted so branching properties come first.
   * Inputs for non-branching properties are still offered — they may appear in
   * switch case labels or ternary branches even if not in a top-level condition.
   */
  readonly simProps = computed<PropInfo[]>(() => {
    const comp = this.comp();
    if (!comp) return [];
    const condNames = this.conditionPropNames();

    return this.method().touchedProperties
      .map(name => {
        const prop = comp.properties.find(p => p.name === name);
        if (!prop) return null;
        const colors = PROP_COLORS[prop.kind] ?? PROP_COLORS['regular'];
        return {
          prop,
          kind: prop.kind,
          bg: colors.bg,
          text: colors.text,
          inCondition: condNames.has(name),
        } as PropInfo;
      })
      .filter(Boolean)
      .sort((a, b) => (b!.inCondition ? 1 : 0) - (a!.inCondition ? 1 : 0)) as PropInfo[];
  });

  /** Properties that appear in conditions — entering these changes which branch runs. */
  readonly branchingProps = computed<PropInfo[]>(() =>
    this.simProps().filter(p => p.inCondition),
  );

  /** Properties accessed in code but not in any condition. */
  readonly accessOnlyProps = computed<PropInfo[]>(() =>
    this.simProps().filter(p => !p.inCondition),
  );

  readonly hasSimValues = computed(() =>
    Object.values(this.simValues()).some(v => v.trim() !== ''),
  );

  readonly displayItems = computed<FlowDisplayItem[]>(() => {
    const nodes = this.flowNodes();
    if (!nodes.length) return [];
    const evaluated = this.parser.evaluate(nodes, this.simValues());
    return this.parser.flatten(evaluated);
  });

  readonly resolvedBranches = computed(() =>
    this.displayItems().filter(i => i.type === 'if-head' && i.result !== null).length,
  );

  readonly totalBranches = computed(() =>
    this.displayItems().filter(i => i.type === 'if-head' && !i.isElse).length,
  );

  /** True if all branching properties have a value entered. */
  readonly allBranchingPropsSet = computed(() => {
    const vals = this.simValues();
    return this.branchingProps().length > 0 &&
           this.branchingProps().every(p => (vals[p.prop.name] ?? '').trim() !== '');
  });

  // ── Event handlers ────────────────────────────────────────────────────────

  onSimInput(name: string, event: Event): void {
    this.state.setSimValue(name, (event.target as HTMLInputElement).value);
  }

  clearSimValues(): void {
    this.state.clearSimValues();
  }

  propKindColor(kind: PropertyKind): string {
    return PROP_COLORS[kind]?.text ?? '#94a3b8';
  }

  navigateToMethod(method: MethodNode): void {
    this.state.selectMethod(method);
  }

  getMethodAccent(method: MethodNode): string {
    if (method.isLifecycle) return 'linear-gradient(90deg,#f59e0b,#fbbf24)';
    if (method.isAsync) return 'linear-gradient(90deg,#3b82f6,#6366f1)';
    return 'linear-gradient(90deg,#6366f1,#8b5cf6)';
  }

  getFormattedBody(): string {
    const body = this.method().body;
    if (!body) return '// (no body detected)';
    const trimmed = body.trim();
    return trimmed.length > 1500 ? trimmed.slice(0, 1500) + '\n// … (truncated)' : trimmed;
  }

  indentPx(depth: number): number {
    return depth * 20;
  }
}
