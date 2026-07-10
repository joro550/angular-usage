import { Component, computed, inject, signal } from '@angular/core';
import { MethodNode, ClassProperty, PropertyKind } from '../models/project.model';
import { StateService } from '../services/state.service';
import {
  FlowParserService,
  FlowDisplayItem,
} from '../services/flow-parser.service';

interface CalledMethodCard {
  method: MethodNode;
}

interface PropChip {
  prop: ClassProperty;
  kind: PropertyKind;
  bg: string;
  text: string;
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

  readonly propChips = computed<PropChip[]>(() => {
    const method = this.method();
    const comp = this.comp();
    if (!comp) return [];
    return method.touchedProperties
      .map(name => {
        const prop = comp.properties.find(p => p.name === name);
        if (!prop) return null;
        const colors = PROP_COLORS[prop.kind] ?? PROP_COLORS['regular'];
        return { prop, kind: prop.kind, ...colors } as PropChip;
      })
      .filter(Boolean) as PropChip[];
  });

  // ── Flow / simulation tab ─────────────────────────────────────────────────

  /** All class properties that this method touches — the set we offer inputs for. */
  readonly simProps = computed<ClassProperty[]>(() => {
    const comp = this.comp();
    if (!comp) return [];
    return this.method().touchedProperties
      .map(name => comp.properties.find(p => p.name === name))
      .filter(Boolean) as ClassProperty[];
  });

  readonly simValues = this.state.simulationValues;

  /** Parse the method body into a flow tree, then evaluate with current values. */
  readonly displayItems = computed<FlowDisplayItem[]>(() => {
    const body = this.method().body;
    if (!body?.trim()) return [];
    const nodes = this.parser.parse(body);
    const evaluated = this.parser.evaluate(nodes, this.simValues());
    return this.parser.flatten(evaluated);
  });

  /** True if any simulation value has been entered. */
  readonly hasSimValues = computed(() =>
    Object.values(this.simValues()).some(v => v.trim() !== ''),
  );

  /** Count of branches that could be evaluated. */
  readonly resolvedBranches = computed(() =>
    this.displayItems().filter(i => i.type === 'if-head' && i.result !== null).length,
  );

  readonly totalBranches = computed(() =>
    this.displayItems().filter(i => i.type === 'if-head' && !i.isElse).length,
  );

  onSimInput(name: string, event: Event): void {
    this.state.setSimValue(name, (event.target as HTMLInputElement).value);
  }

  clearSimValues(): void {
    this.state.clearSimValues();
  }

  propKindColor(kind: PropertyKind): string {
    return PROP_COLORS[kind]?.text ?? '#94a3b8';
  }

  // ── Shared helpers ────────────────────────────────────────────────────────

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
