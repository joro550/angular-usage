import { Component, computed, inject } from '@angular/core';
import { MethodNode, ClassProperty, PropertyKind } from '../models/project.model';
import { StateService } from '../services/state.service';

interface CalledMethodCard {
  method: MethodNode;
  x: number;
  y: number;
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

@Component({
  selector: 'app-function-detail',
  standalone: true,
  template: `
    <div class="h-full flex flex-col bg-[#07070e] text-slate-200 overflow-hidden">

      <!-- Breadcrumb -->
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
        <button
          class="text-slate-400 hover:text-white transition-colors text-sm"
          (click)="state.backToComponent()"
        >
          {{ comp()?.name }}
        </button>
        <span class="text-slate-700">/</span>
        <span class="text-white font-mono font-semibold">{{ method().name }}</span>
        @if (method().isAsync) {
          <span class="px-2 py-0.5 rounded text-[10px] bg-blue-500/20 text-blue-400 font-mono">async</span>
        }
        @if (method().isLifecycle) {
          <span class="px-2 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-400 font-mono">lifecycle</span>
        }
      </div>

      <div class="flex-1 overflow-auto px-6 py-6 space-y-8">

        <!-- Selected function card (large) -->
        <div class="flex justify-center">
          <div
            class="relative rounded-2xl border-2 border-indigo-500 bg-indigo-500/8
                   px-8 py-6 max-w-xl w-full shadow-[0_0_40px_rgba(99,102,241,0.2)]"
          >
            <!-- Glow pulse -->
            <div class="absolute -inset-px rounded-2xl pointer-events-none"
                 style="background: linear-gradient(135deg,rgba(99,102,241,0.1),rgba(139,92,246,0.1))"></div>

            <div class="relative">
              <div class="flex items-start gap-3 mb-3">
                <div class="text-indigo-400 mt-0.5">
                  <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                      d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5"/>
                  </svg>
                </div>
                <div>
                  <div class="font-mono font-bold text-xl text-white">{{ method().name }}</div>
                  @if (method().params) {
                    <div class="text-slate-400 font-mono text-sm mt-1">
                      (<span class="text-slate-300">{{ method().params }}</span>)
                    </div>
                  }
                </div>
              </div>

              <!-- Stats row -->
              <div class="flex flex-wrap gap-4 text-xs text-slate-500 border-t border-slate-800 pt-3">
                <span>
                  <span class="text-slate-400 font-semibold">{{ calledMethodCards().length }}</span>
                  method{{ calledMethodCards().length !== 1 ? 's' : '' }} called
                </span>
                <span>
                  <span class="text-slate-400 font-semibold">{{ propChips().length }}</span>
                  propert{{ propChips().length !== 1 ? 'ies' : 'y' }} touched
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Called methods -->
        @if (calledMethodCards().length > 0) {
          <section>
            <h2 class="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-3">
              <svg class="w-3 h-3 text-indigo-500" fill="currentColor" viewBox="0 0 20 20">
                <path fill-rule="evenodd" d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z" clip-rule="evenodd"/>
              </svg>
              Calls these methods
            </h2>

            <div class="flex flex-wrap gap-4">
              @for (card of calledMethodCards(); track card.method.id) {
                <button
                  class="group relative rounded-xl border border-slate-800 bg-slate-900/60
                         hover:border-indigo-500/60 hover:bg-indigo-500/5
                         transition-all duration-150 text-left cursor-pointer"
                  style="min-width: 200px"
                  (click)="navigateToMethod(card.method)"
                >
                  <!-- Top bar -->
                  <div
                    class="absolute top-0 left-0 right-0 h-[2px] rounded-t-xl"
                    [style.background]="getMethodAccent(card.method)"
                  ></div>

                  <div class="px-4 py-3">
                    <div class="flex items-center gap-2 mb-1.5">
                      @if (card.method.isAsync) {
                        <span class="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 font-mono">async</span>
                      }
                      @if (card.method.isLifecycle) {
                        <span class="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-mono">lifecycle</span>
                      }
                    </div>
                    <div class="font-mono text-sm font-semibold text-slate-200 group-hover:text-indigo-300 transition-colors">
                      {{ card.method.name }}
                    </div>
                    @if (card.method.params) {
                      <div class="text-[10px] text-slate-600 font-mono mt-0.5">
                        ({{ card.method.params }})
                      </div>
                    }
                    @if (card.method.touchedProperties.length > 0) {
                      <div class="flex flex-wrap gap-1 mt-2">
                        @for (p of card.method.touchedProperties.slice(0, 3); track p) {
                          <span class="text-[9px] px-1 py-0.5 rounded bg-slate-800 text-slate-500 font-mono">{{ p }}</span>
                        }
                        @if (card.method.touchedProperties.length > 3) {
                          <span class="text-[9px] text-slate-600">+{{ card.method.touchedProperties.length - 3 }}</span>
                        }
                      </div>
                    }
                  </div>
                </button>
              }
            </div>
          </section>
        }

        <!-- Touched properties -->
        @if (propChips().length > 0) {
          <section>
            <h2 class="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-3">
              <svg class="w-3 h-3 text-violet-500" fill="currentColor" viewBox="0 0 20 20">
                <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z"/>
              </svg>
              Class properties touched
            </h2>

            <div class="flex flex-wrap gap-3">
              @for (chip of propChips(); track chip.prop.name) {
                <div
                  class="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-800
                         bg-slate-900/40"
                >
                  <!-- Color dot -->
                  <div
                    class="w-2 h-2 rounded-full flex-none"
                    [style.background]="chip.text"
                  ></div>
                  <span class="font-mono text-sm font-semibold text-slate-300">{{ chip.prop.name }}</span>
                  <span
                    class="text-[10px] px-1.5 py-0.5 rounded font-mono"
                    [style.background]="chip.bg"
                    [style.color]="chip.text"
                  >
                    {{ chip.kind }}
                  </span>
                </div>
              }
            </div>
          </section>
        }

        <!-- No data state -->
        @if (calledMethodCards().length === 0 && propChips().length === 0) {
          <div class="flex flex-col items-center justify-center py-16 text-slate-600">
            <svg class="w-12 h-12 mb-4 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1"
                d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5"/>
            </svg>
            <p class="text-sm">This method doesn't call other class methods</p>
            <p class="text-xs mt-1 opacity-70">and doesn't interact with class properties</p>
          </div>
        }

        <!-- Method body preview -->
        <section>
          <h2 class="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-3">
            Method Body
          </h2>
          <div class="rounded-xl border border-slate-800 bg-slate-950/60 overflow-auto max-h-64">
            <pre class="p-4 text-xs font-mono text-slate-400 leading-relaxed whitespace-pre-wrap break-all">{{ getFormattedBody() }}</pre>
          </div>
        </section>

      </div>
    </div>
  `,
})
export class FunctionDetailComponent {
  readonly state = inject(StateService);

  readonly method = computed(() => this.state.selectedMethod()!);
  readonly comp = computed(() => this.state.selectedComponent());

  readonly calledMethodCards = computed<CalledMethodCard[]>(() => {
    const method = this.method();
    const comp = this.comp();
    if (!comp) return [];

    return method.calledMethods
      .map((name, i) => {
        const m = comp.methods.find(m => m.name === name);
        if (!m) return null;
        return { method: m, x: 0, y: 0 } as CalledMethodCard;
      })
      .filter(Boolean) as CalledMethodCard[];
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
    return trimmed.length > 1500 ? trimmed.slice(0, 1500) + '\n// ... (truncated)' : trimmed;
  }
}
