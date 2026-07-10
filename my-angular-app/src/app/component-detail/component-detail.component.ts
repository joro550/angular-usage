import { Component, computed, inject } from '@angular/core';
import { ClassProperty, ComponentNode, MethodNode, PropertyKind } from '../models/project.model';
import { StateService } from '../services/state.service';

interface MethodLayoutNode {
  method: MethodNode;
  col: number;
  row: number;
  x: number;
  y: number;
}

interface MethodEdge {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
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
  readonly CARD_W = CARD_W;

  readonly comp = computed(() => this.state.selectedComponent()!);

  readonly usedByComponents = computed<ComponentNode[]>(() => {
    const proj = this.state.project();
    const comp = this.comp();
    if (!proj) return [];
    return comp.usedBy
      .map(id => proj.components.find(c => c.id === id))
      .filter(Boolean) as ComponentNode[];
  });

  readonly usesComponents = computed<ComponentNode[]>(() => {
    const proj = this.state.project();
    const comp = this.comp();
    if (!proj) return [];
    return comp.usedComponents
      .map(id => proj.components.find(c => c.id === id))
      .filter(Boolean) as ComponentNode[];
  });

  readonly methodLayout = computed(() => {
    const methods = this.comp().methods;
    return this.computeMethodLayout(methods);
  });

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

  private computeMethodLayout(methods: MethodNode[]): {
    nodes: MethodLayoutNode[];
    edges: MethodEdge[];
    height: number;
  } {
    if (methods.length === 0) return { nodes: [], edges: [], height: 0 };

    // Build a map of who calls whom
    const calledByOthers = new Set<string>();
    for (const m of methods) {
      for (const called of m.calledMethods) calledByOthers.add(called);
    }

    // Assign columns via BFS from entry methods
    const colMap = new Map<string, number>();
    const queue: { name: string; col: number }[] = [];

    // Entry methods (not called by others) start at col 0
    for (const m of methods) {
      if (!calledByOthers.has(m.name)) {
        queue.push({ name: m.name, col: 0 });
      }
    }
    // If everything calls everything, put all at col 0
    if (queue.length === 0) {
      for (const m of methods) queue.push({ name: m.name, col: 0 });
    }

    while (queue.length > 0) {
      const { name, col } = queue.shift()!;
      if (colMap.has(name) && colMap.get(name)! >= col) continue;
      colMap.set(name, col);

      const method = methods.find(m => m.name === name);
      if (method) {
        for (const called of method.calledMethods) {
          queue.push({ name: called, col: col + 1 });
        }
      }
    }

    // Any unreachable methods go to col 0
    for (const m of methods) {
      if (!colMap.has(m.name)) colMap.set(m.name, 0);
    }

    // Group by column
    const byCol = new Map<number, MethodNode[]>();
    for (const m of methods) {
      const col = colMap.get(m.name) ?? 0;
      if (!byCol.has(col)) byCol.set(col, []);
      byCol.get(col)!.push(m);
    }

    // Build positioned nodes
    const nodes: MethodLayoutNode[] = [];
    const posMap = new Map<string, { x: number; y: number }>();

    const cols = [...byCol.keys()].sort((a, b) => a - b);
    for (const col of cols) {
      const colMethods = byCol.get(col)!;
      const x = col * (CARD_W + COL_GAP);
      colMethods.forEach((method, row) => {
        const y = row * (CARD_H + ROW_GAP);
        nodes.push({ method, col, row, x, y });
        posMap.set(method.name, { x, y });
      });
    }

    // Compute total height
    const maxRow = Math.max(...nodes.map(n => n.row), 0);
    const height = (maxRow + 1) * (CARD_H + ROW_GAP);

    // Build edges
    const edges: MethodEdge[] = [];
    for (const node of nodes) {
      const fromPos = posMap.get(node.method.name);
      if (!fromPos) continue;

      for (const calledName of node.method.calledMethods) {
        const toPos = posMap.get(calledName);
        if (!toPos) continue;

        const x1 = fromPos.x + CARD_W;
        const y1 = fromPos.y + CARD_H / 2;
        const x2 = toPos.x;
        const y2 = toPos.y + CARD_H / 2;

        const cp = (x2 - x1) * 0.4 + 20;
        const path = `M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`;

        edges.push({
          id: `${node.method.name}->${calledName}`,
          x1,
          y1,
          x2,
          y2,
          path,
        });
      }
    }

    return { nodes, edges, height };
  }
}
