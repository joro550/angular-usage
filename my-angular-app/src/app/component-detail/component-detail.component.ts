import { Component, computed, inject, signal } from '@angular/core';
import { ClassProperty, ComponentNode, MethodNode, PropertyKind } from '../models/project.model';
import { StateService } from '../services/state.service';
import { FlowParserService } from '../services/flow-parser.service';

interface MethodLayoutNode {
  method: MethodNode;
  col: number;
  row: number;
  x: number;
  y: number;
}

interface MethodEdge {
  id: string;
  x1: number; y1: number;
  x2: number; y2: number;
  path: string;
}

const PROP_COLORS: Record<PropertyKind, { bg: string; text: string; label: string }> = {
  signal:   { bg: 'rgba(34,197,94,0.15)',   text: '#4ade80', label: 'signal'   },
  computed: { bg: 'rgba(168,85,247,0.15)',  text: '#c084fc', label: 'computed' },
  input:    { bg: 'rgba(59,130,246,0.15)',  text: '#60a5fa', label: 'input'    },
  output:   { bg: 'rgba(249,115,22,0.15)',  text: '#fb923c', label: 'output'   },
  model:    { bg: 'rgba(236,72,153,0.15)',  text: '#f472b6', label: 'model'    },
  inject:   { bg: 'rgba(100,116,139,0.15)', text: '#94a3b8', label: 'inject'   },
  regular:  { bg: 'rgba(71,85,105,0.12)',   text: '#64748b', label: 'field'    },
};

const CARD_W = 200;
const CARD_H = 54;
const COL_GAP = 80;
const ROW_GAP = 20;

@Component({
  selector: 'app-component-detail',
  standalone: true,
  templateUrl: './component-detail.component.html',
})
export class ComponentDetailComponent {
  readonly state = inject(StateService);
  private readonly flowParser = inject(FlowParserService);
  readonly CARD_W = CARD_W;

  readonly comp = computed(() => this.state.selectedComponent()!);
  readonly simValues = this.state.simulationValues;
  readonly showSimPanel = signal(false);
  readonly hasSimValues = computed(() =>
    Object.values(this.simValues()).some(v => v.trim() !== ''),
  );

  readonly usedByComponents = computed<ComponentNode[]>(() => {
    const proj = this.state.project();
    const comp = this.comp();
    if (!proj) return [];
    return comp.usedBy.map(id => proj.components.find(c => c.id === id)).filter(Boolean) as ComponentNode[];
  });

  readonly usesComponents = computed<ComponentNode[]>(() => {
    const proj = this.state.project();
    const comp = this.comp();
    if (!proj) return [];
    return comp.usedComponents.map(id => proj.components.find(c => c.id === id)).filter(Boolean) as ComponentNode[];
  });

  readonly methodLayout = computed(() => this.computeMethodLayout(this.comp().methods));

  // ── Simulation ─────────────────────────────────────────────────────

  /**
   * For each method, the set of class property names that appear in its
   * branching conditions (if/else-if/switch/loop guards). Pre-computed once
   * when the component changes so the template doesn’t parse on every render.
   */
  readonly allMethodConditionProps = computed<Map<string, Set<string>>>(() => {
    const comp = this.comp();
    const propNames = new Set(comp.properties.map(p => p.name));
    const map = new Map<string, Set<string>>();
    for (const method of comp.methods) {
      if (!method.body?.trim()) { map.set(method.id, new Set()); continue; }
      try {
        const nodes = this.flowParser.parse(method.body);
        const raw = this.flowParser.extractConditionProps(nodes);
        map.set(method.id, new Set([...raw].filter(n => propNames.has(n))));
      } catch {
        map.set(method.id, new Set());
      }
    }
    return map;
  });

  /** Union of all condition properties across every method in this component. */
  readonly conditionPropNames = computed<Set<string>>(() => {
    const result = new Set<string>();
    for (const [, props] of this.allMethodConditionProps()) {
      for (const p of props) result.add(p);
    }
    return result;
  });

  /** Whether a specific property appears in a specific method’s conditions. */
  isConditionPropFor(methodId: string, propName: string): boolean {
    return this.allMethodConditionProps().get(methodId)?.has(propName) ?? false;
  }

  /** Count how many branches in a method can be resolved with current values. */
  methodBranchStatus(method: MethodNode): { resolved: number; total: number } {
    if (!method.body?.trim()) return { resolved: 0, total: 0 };
    const nodes = this.flowParser.parse(method.body);
    const evaluated = this.flowParser.evaluate(nodes, this.simValues());
    const items = this.flowParser.flatten(evaluated);
    const total = items.filter(i => i.type === 'if-head' && !i.isElse).length;
    const resolved = items.filter(i => i.type === 'if-head' && i.result !== null).length;
    return { resolved, total };
  }

  onSimInput(name: string, event: Event): void {
    this.state.setSimValue(name, (event.target as HTMLInputElement).value);
  }

  clearSimValues(): void {
    this.state.clearSimValues();
  }

  getSimValuePlaceholder(prop: ClassProperty): string {
    switch (prop.kind) {
      case 'signal': case 'model': return 'e.g. true, 42, "hello"';
      case 'input': return 'e.g. "value"';
      case 'computed': return '(read-only)';
      default: return 'value';
    }
  }

  isReadOnly(prop: ClassProperty): boolean {
    return prop.kind === 'computed' || prop.kind === 'output';
  }

  // ── Appearance helpers ─────────────────────────────────────────────────────

  propColors(kind: PropertyKind) {
    return PROP_COLORS[kind] ?? PROP_COLORS['regular'];
  }

  getMethodBorder(method: MethodNode): string {
    if (method.isLifecycle) return 'rgba(245,158,11,0.4)';
    if (method.isAsync) return 'rgba(59,130,246,0.4)';
    return 'rgba(45,45,80,0.8)';
  }

  getMethodAccent(method: MethodNode): string {
    if (method.isLifecycle) return 'linear-gradient(90deg,#f59e0b,#fbbf24)';
    if (method.isAsync) return 'linear-gradient(90deg,#3b82f6,#6366f1)';
    return 'linear-gradient(90deg,#6366f1,#8b5cf6)';
  }

  // ── Method layout ──────────────────────────────────────────────────────────

  private computeMethodLayout(methods: MethodNode[]): {
    nodes: MethodLayoutNode[];
    edges: MethodEdge[];
    height: number;
  } {
    if (methods.length === 0) return { nodes: [], edges: [], height: 0 };

    const calledByOthers = new Set<string>();
    for (const m of methods) for (const c of m.calledMethods) calledByOthers.add(c);

    const colMap = new Map<string, number>();
    const queue: { name: string; col: number }[] = [];
    for (const m of methods) if (!calledByOthers.has(m.name)) queue.push({ name: m.name, col: 0 });
    if (queue.length === 0) for (const m of methods) queue.push({ name: m.name, col: 0 });

    while (queue.length > 0) {
      const { name, col } = queue.shift()!;
      if (colMap.has(name) && colMap.get(name)! >= col) continue;
      colMap.set(name, col);
      const method = methods.find(m => m.name === name);
      if (method) for (const c of method.calledMethods) queue.push({ name: c, col: col + 1 });
    }
    for (const m of methods) if (!colMap.has(m.name)) colMap.set(m.name, 0);

    const byCol = new Map<number, MethodNode[]>();
    for (const m of methods) {
      const col = colMap.get(m.name) ?? 0;
      if (!byCol.has(col)) byCol.set(col, []);
      byCol.get(col)!.push(m);
    }

    const nodes: MethodLayoutNode[] = [];
    const posMap = new Map<string, { x: number; y: number }>();
    for (const col of [...byCol.keys()].sort((a, b) => a - b)) {
      const colMethods = byCol.get(col)!;
      const x = col * (CARD_W + COL_GAP);
      colMethods.forEach((method, row) => {
        const y = row * (CARD_H + ROW_GAP);
        nodes.push({ method, col, row, x, y });
        posMap.set(method.name, { x, y });
      });
    }

    const maxRow = Math.max(...nodes.map(n => n.row), 0);
    const height = (maxRow + 1) * (CARD_H + ROW_GAP);

    const edges: MethodEdge[] = [];
    for (const node of nodes) {
      const fp = posMap.get(node.method.name);
      if (!fp) continue;
      for (const calledName of node.method.calledMethods) {
        const tp = posMap.get(calledName);
        if (!tp) continue;
        const x1 = fp.x + CARD_W, y1 = fp.y + CARD_H / 2;
        const x2 = tp.x,          y2 = tp.y + CARD_H / 2;
        const cp = (x2 - x1) * 0.4 + 20;
        edges.push({
          id: `${node.method.name}->${calledName}`,
          x1, y1, x2, y2,
          path: `M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`,
        });
      }
    }

    return { nodes, edges, height };
  }
}
