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
  template: `
    <div class="h-full flex flex-col bg-[#07070e] text-slate-200 overflow-hidden">

      <!-- Header / Breadcrumb -->
      <div class="flex-none flex items-center gap-3 px-5 py-3 border-b border-slate-800 bg-[#07070e]/80">
        <button
          class="flex items-center gap-1.5 text-slate-400 hover:text-white transition-colors text-sm"
          (click)="state.backToOverview()"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"/>
          </svg>
          Overview
        </button>
        <span class="text-slate-700">/</span>
        <span class="text-white font-mono font-semibold">{{ comp().name }}</span>
        <span class="ml-auto text-[10px] text-slate-600 font-mono truncate max-w-xs">{{ comp().filePath }}</span>
      </div>

      <div class="flex-1 overflow-auto">

        <!-- Component Relationships -->
        <section class="px-6 py-5 border-b border-slate-800/70">
          <h2 class="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-4">
            Component Relationships
          </h2>

          <div class="flex items-start gap-6">

            <!-- Used By -->
            <div class="flex-1 min-w-0">
              <div class="text-xs text-slate-500 mb-2 flex items-center gap-2">
                <span>Used by</span>
                <span class="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 text-[10px]">
                  {{ usedByComponents().length }}
                </span>
              </div>
              <div class="flex flex-wrap gap-2">
                @for (parent of usedByComponents(); track parent.id) {
                  <button
                    class="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800
                           text-xs font-mono text-slate-300 hover:border-indigo-500
                           hover:text-indigo-300 transition-colors"
                    (click)="state.selectComponent(parent)"
                  >
                    {{ parent.name }}
                  </button>
                }
                @empty {
                  <span class="text-xs text-slate-700 italic">Not used by any component</span>
                }
              </div>
            </div>

            <!-- Center: this component -->
            <div
              class="flex-none px-5 py-3 rounded-xl border-2 border-indigo-500
                     bg-indigo-500/10 text-center"
            >
              <div class="font-mono font-bold text-white text-sm">{{ comp().name }}</div>
              <div class="text-[10px] text-indigo-400 font-mono mt-0.5">{{ comp().selector }}</div>
            </div>

            <!-- Uses -->
            <div class="flex-1 min-w-0">
              <div class="text-xs text-slate-500 mb-2 flex items-center gap-2">
                <span>Uses</span>
                <span class="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 text-[10px]">
                  {{ usesComponents().length }}
                </span>
              </div>
              <div class="flex flex-wrap gap-2">
                @for (child of usesComponents(); track child.id) {
                  <button
                    class="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800
                           text-xs font-mono text-slate-300 hover:border-violet-500
                           hover:text-violet-300 transition-colors"
                    (click)="state.selectComponent(child)"
                  >
                    {{ child.name }}
                  </button>
                }
                @empty {
                  <span class="text-xs text-slate-700 italic">No child components</span>
                }
              </div>
            </div>
          </div>
        </section>

        <!-- Properties -->
        <section class="px-6 py-5 border-b border-slate-800/70">
          <h2 class="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-3">
            Class Properties
          </h2>
          <div class="flex flex-wrap gap-2">
            @for (prop of comp().properties; track prop.name) {
              @let colors = propColors(prop.kind);
              <span
                class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono"
                [style.background]="colors.bg"
                [style.color]="colors.text"
              >
                <span class="font-semibold">{{ prop.name }}</span>
                <span class="opacity-60 text-[10px]">{{ colors.label }}</span>
              </span>
            }
            @empty {
              <span class="text-xs text-slate-700 italic">No properties detected</span>
            }
          </div>
        </section>

        <!-- Method Call Graph -->
        <section class="px-6 py-5">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-xs font-semibold text-slate-500 uppercase tracking-widest">
              Method Call Graph
            </h2>
            <span class="text-xs text-slate-600">Click a method to inspect it</span>
          </div>

          @if (comp().methods.length === 0) {
            <p class="text-xs text-slate-700 italic">No methods detected</p>
          } @else {
            @let layout = methodLayout();
            <div
              class="relative"
              [style.height.px]="layout.height + 40"
              [style.min-height.px]="200"
            >
              <!-- SVG edges -->
              <svg
                class="absolute inset-0 w-full pointer-events-none overflow-visible"
                [attr.height]="layout.height + 40"
              >
                <defs>
                  <marker
                    id="method-arrow"
                    markerWidth="8"
                    markerHeight="6"
                    refX="7"
                    refY="3"
                    orient="auto"
                  >
                    <polygon points="0 0, 8 3, 0 6" fill="rgba(99,102,241,0.7)" />
                  </marker>
                </defs>
                @for (edge of layout.edges; track edge.id) {
                  <path
                    [attr.d]="edge.path"
                    fill="none"
                    stroke="rgba(99,102,241,0.45)"
                    stroke-width="1.5"
                    marker-end="url(#method-arrow)"
                  />
                }
              </svg>

              <!-- Method nodes -->
              @for (node of layout.nodes; track node.method.id) {
                <div
                  class="absolute rounded-lg border cursor-pointer transition-all duration-150
                         hover:border-indigo-500 hover:shadow-[0_0_12px_rgba(99,102,241,0.3)]
                         group"
                  [style.left.px]="node.x"
                  [style.top.px]="node.y"
                  [style.width.px]="CARD_W"
                  [style.border-color]="getMethodBorder(node.method)"
                  [style.background]="'rgba(13,13,26,0.95)'"
                  (click)="state.selectMethod(node.method)"
                >
                  <!-- Top accent -->
                  <div
                    class="absolute top-0 left-0 right-0 h-[2px] rounded-t-lg"
                    [style.background]="getMethodAccent(node.method)"
                  ></div>

                  <div class="px-3 py-2">
                    <div class="flex items-center gap-2 mb-1">
                      @if (node.method.isAsync) {
                        <span class="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 font-mono">async</span>
                      }
                      @if (node.method.isLifecycle) {
                        <span class="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-mono">lifecycle</span>
                      }
                    </div>
                    <div class="font-mono text-xs font-semibold text-slate-200 truncate group-hover:text-indigo-300 transition-colors">
                      {{ node.method.name }}
                    </div>
                    @if (node.method.params) {
                      <div class="text-[10px] text-slate-600 font-mono truncate mt-0.5">
                        ({{ node.method.params }})
                      </div>
                    }
                    @if (node.method.touchedProperties.length > 0) {
                      <div class="flex flex-wrap gap-1 mt-2">
                        @for (prop of node.method.touchedProperties.slice(0, 4); track prop) {
                          <span class="text-[9px] px-1 py-0.5 rounded bg-slate-800 text-slate-500 font-mono">
                            {{ prop }}
                          </span>
                        }
                        @if (node.method.touchedProperties.length > 4) {
                          <span class="text-[9px] text-slate-600">+{{ node.method.touchedProperties.length - 4 }}</span>
                        }
                      </div>
                    }
                  </div>
                </div>
              }
            </div>
          }
        </section>

      </div>
    </div>
  `,
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
