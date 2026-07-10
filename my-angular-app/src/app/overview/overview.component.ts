import {
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { ComponentNode } from '../models/project.model';
import { StateService } from '../services/state.service';

interface EdgeData {
  id: string;
  path: string;
  opacity: number;
}

interface CardDimensions {
  w: number;
  h: number;
  fontSize: number;
}

const BASE_W = 200;
const BASE_H = 110;
const MAX_SCALE = 1.75;

@Component({
  selector: 'app-overview',
  standalone: true,
  host: {
    class: 'block w-full h-full',
  },
  template: `
    <!-- Top bar -->
    <div
      class="absolute top-0 left-0 right-0 z-20 flex items-center gap-4 px-5 py-3
             bg-[#07070e]/80 backdrop-blur border-b border-slate-800/60"
    >
      <div class="flex items-center gap-2">
        <svg width="22" height="22" viewBox="0 0 40 40" fill="none">
          <rect width="40" height="40" rx="10" fill="url(#logo-g)" />
          <path d="M10 28 L20 12 L30 28" stroke="white" stroke-width="2.5" stroke-linejoin="round" fill="none"/>
          <path d="M14 23 L26 23" stroke="white" stroke-width="2" stroke-linecap="round"/>
          <defs>
            <linearGradient id="logo-g" x1="0" y1="0" x2="40" y2="40">
              <stop offset="0%" stop-color="#6366f1"/>
              <stop offset="100%" stop-color="#8b5cf6"/>
            </linearGradient>
          </defs>
        </svg>
        <span class="text-white font-semibold text-sm">Angular Analyzer</span>
      </div>

      <div class="flex items-center gap-2 text-xs text-slate-400">
        <span class="px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700">
          {{ project()!.components.length }} components
        </span>
        <span class="px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700">
          {{ totalEdges() }} relationships
        </span>
      </div>

      <div class="ml-auto flex items-center gap-3 text-xs text-slate-500">
        <span>Drag to reposition · Click to inspect</span>
        <button
          class="px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 transition-colors"
          (click)="resetLayout()"
        >
          Reset layout
        </button>
        <button
          class="px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 transition-colors"
          (click)="state.resetToUpload()"
        >
          Load new
        </button>
      </div>
    </div>

    <!-- Graph canvas -->
    <div
      #canvas
      class="absolute inset-0 pt-[52px] overflow-hidden bg-[#07070e]"
      (pointermove)="onPointerMove($event)"
      (pointerup)="onPointerUp($event)"
      (pointercancel)="onPointerUp($event)"
    >
      <!-- Grid pattern background -->
      <svg class="absolute inset-0 w-full h-full opacity-[0.03] pointer-events-none">
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="white" stroke-width="0.5"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)"/>
      </svg>

      <!-- Connection lines SVG -->
      <svg
        class="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
        style="z-index: 0"
      >
        <defs>
          <marker
            id="arrowhead"
            markerWidth="9"
            markerHeight="7"
            refX="8"
            refY="3.5"
            orient="auto"
          >
            <polygon points="0 0, 9 3.5, 0 7" fill="rgba(139,92,246,0.6)" />
          </marker>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
            <feMerge>
              <feMergeNode in="coloredBlur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
        </defs>

        @for (edge of edges(); track edge.id) {
          <path
            [attr.d]="edge.path"
            fill="none"
            [attr.stroke-opacity]="edge.opacity"
            stroke="rgb(139,92,246)"
            stroke-width="1.5"
            marker-end="url(#arrowhead)"
          />
        }
      </svg>

      <!-- Component cards -->
      @for (comp of project()!.components; track comp.id) {
        @let pos = positions()[comp.id] ?? { x: comp.x, y: comp.y };
        @let dim = getCardDimensions(comp);
        @let isActive = draggingId() === comp.id;
        <div
          class="absolute select-none transition-shadow duration-150"
          [style.left.px]="pos.x"
          [style.top.px]="pos.y"
          [style.width.px]="dim.w"
          [style.height.px]="dim.h"
          [style.z-index]="isActive ? 100 : 2"
          [style.filter]="isActive ? 'drop-shadow(0 0 16px rgba(139,92,246,0.5))' : 'none'"
          (pointerdown)="startDrag($event, comp.id)"
        >
          <div
            class="w-full h-full rounded-xl border backdrop-blur-sm overflow-hidden
                   transition-colors duration-200 group"
            [style.border-color]="getCardBorderColor(comp)"
            [style.background]="'rgba(13,13,26,0.92)'"
            [class.cursor-grabbing]="isActive"
            [class.cursor-grab]="!isActive"
          >
            <!-- Gradient top accent -->
            <div
              class="absolute top-0 left-0 right-0 h-[2px] rounded-t-xl opacity-80"
              [style.background]="getCardAccent(comp)"
            ></div>

            <!-- Usage badge -->
            @if (comp.usedBy.length > 0) {
              <div
                class="absolute -top-2.5 -right-2.5 min-w-[22px] h-[22px] rounded-full
                       bg-violet-600 flex items-center justify-center text-[10px]
                       text-white font-bold px-1 shadow-lg border border-violet-400/40"
              >
                ×{{ comp.usedBy.length }}
              </div>
            }

            <div class="p-3 h-full flex flex-col gap-1">
              <!-- Name -->
              <div
                class="font-mono font-bold text-white leading-tight truncate"
                [style.font-size.px]="dim.fontSize"
              >
                {{ comp.name }}
              </div>

              <!-- Selector -->
              <div class="text-[10px] text-indigo-400/80 font-mono truncate">
                {{ comp.selector }}
              </div>

              <!-- Stats -->
              <div class="mt-auto flex gap-3 text-[10px] text-slate-600">
                <span class="text-slate-500">{{ comp.methods.length }} methods</span>
                <span class="text-slate-600">{{ comp.properties.length }} props</span>
                @if (comp.usedComponents.length > 0) {
                  <span class="text-indigo-600">→ {{ comp.usedComponents.length }}</span>
                }
              </div>
            </div>
          </div>
        </div>
      }

      <!-- Legend -->
      <div
        class="absolute bottom-4 left-4 flex flex-col gap-1.5 text-[10px] text-slate-600
               bg-[#07070e]/70 backdrop-blur rounded-lg p-3 border border-slate-800/60"
      >
        <div class="flex items-center gap-2">
          <div class="w-4 h-[2px]" style="background: rgb(139,92,246)"></div>
          <span>uses component</span>
        </div>
        <div class="flex items-center gap-2">
          <div class="w-3 h-3 rounded-full border-2 border-violet-500"></div>
          <span>×N = used N times</span>
        </div>
        <div class="flex items-center gap-2">
          <div class="w-3 h-3 rounded-sm" style="background: rgba(99,102,241,0.3)"></div>
          <span>larger = more uses</span>
        </div>
      </div>
    </div>
  `,
})
export class OverviewComponent {
  readonly state = inject(StateService);

  readonly project = computed(() => this.state.project()!);

  readonly positions = signal<Record<string, { x: number; y: number }>>({});
  readonly draggingId = signal<string | null>(null);

  private dragState: {
    id: string;
    offsetX: number;
    offsetY: number;
    startClientX: number;
    startClientY: number;
    moved: boolean;
  } | null = null;

  readonly totalEdges = computed(() => {
    const proj = this.state.project();
    if (!proj) return 0;
    return proj.components.reduce((sum, c) => sum + c.usedComponents.length, 0);
  });

  readonly edges = computed<EdgeData[]>(() => {
    const pos = this.positions();
    const proj = this.project();
    const result: EdgeData[] = [];

    for (const comp of proj.components) {
      const fromPos = pos[comp.id];
      if (!fromPos) continue;
      const fromDim = this.getCardDimensions(comp);

      for (const usedId of comp.usedComponents) {
        const toPos = pos[usedId];
        const toComp = proj.components.find(c => c.id === usedId);
        if (!toPos || !toComp) continue;
        const toDim = this.getCardDimensions(toComp);

        result.push({
          id: `${comp.id}->${usedId}`,
          path: this.computePath(fromPos, fromDim, toPos, toDim),
          opacity: 0.45 + Math.min(toComp.usedBy.length, 5) * 0.08,
        });
      }
    }
    return result;
  });

  constructor() {
    effect(() => {
      const proj = this.state.project();
      if (!proj) return;
      const init: Record<string, { x: number; y: number }> = {};
      for (const c of proj.components) init[c.id] = { x: c.x, y: c.y };
      this.positions.set(init);
    });
  }

  startDrag(event: PointerEvent, id: string): void {
    if (event.button !== 0) return;
    event.stopPropagation();

    const pos = this.positions()[id] ?? { x: 0, y: 0 };
    this.dragState = {
      id,
      offsetX: event.clientX - pos.x,
      offsetY: event.clientY - pos.y,
      startClientX: event.clientX,
      startClientY: event.clientY,
      moved: false,
    };
    this.draggingId.set(id);
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.dragState) return;

    const dx = Math.abs(event.clientX - this.dragState.startClientX);
    const dy = Math.abs(event.clientY - this.dragState.startClientY);
    if (dx > 4 || dy > 4) this.dragState.moved = true;

    const newX = event.clientX - this.dragState.offsetX;
    const newY = event.clientY - this.dragState.offsetY;
    const id = this.dragState.id;

    this.positions.update(p => ({ ...p, [id]: { x: newX, y: newY } }));
  }

  onPointerUp(event: PointerEvent): void {
    if (this.dragState) {
      if (!this.dragState.moved) {
        // Short press with no movement = click → navigate to component
        const id = this.dragState.id;
        const comp = this.project().components.find(c => c.id === id);
        if (comp) this.state.selectComponent(comp);
      }
      this.dragState = null;
      this.draggingId.set(null);
    }
  }

  resetLayout(): void {
    const proj = this.project();
    const init: Record<string, { x: number; y: number }> = {};
    for (const c of proj.components) init[c.id] = { x: c.x, y: c.y };
    this.positions.set(init);
  }

  getCardDimensions(comp: ComponentNode): CardDimensions {
    const scale = 1 + Math.min(comp.usedBy.length, 6) / 6 * (MAX_SCALE - 1);
    const w = Math.round(BASE_W * scale);
    const h = Math.round(BASE_H * scale);
    const fontSize = scale > 1.3 ? 14 : 12;
    return { w, h, fontSize };
  }

  getCardBorderColor(comp: ComponentNode): string {
    const n = comp.usedBy.length;
    if (n === 0) return 'rgba(45,45,80,0.8)';
    if (n <= 2) return 'rgba(79,70,229,0.7)';
    if (n <= 4) return 'rgba(139,92,246,0.8)';
    return 'rgba(167,139,250,1)';
  }

  getCardAccent(comp: ComponentNode): string {
    const n = comp.usedBy.length;
    if (n === 0) return 'linear-gradient(90deg, #6366f1, #8b5cf6)';
    if (n <= 2) return 'linear-gradient(90deg, #6366f1, #a855f7)';
    if (n <= 4) return 'linear-gradient(90deg, #8b5cf6, #d946ef)';
    return 'linear-gradient(90deg, #a855f7, #ec4899)';
  }

  private computePath(
    from: { x: number; y: number },
    fromDim: CardDimensions,
    to: { x: number; y: number },
    toDim: CardDimensions,
  ): string {
    const x1 = from.x + fromDim.w / 2;
    const y1 = from.y + fromDim.h / 2;
    const x2 = to.x + toDim.w / 2;
    const y2 = to.y + toDim.h / 2;

    const dx = x2 - x1;
    const dy = y2 - y1;
    const cpOffset = Math.min(Math.abs(dx) * 0.5, 120) + 20;

    // Curve control points
    const cp1x = x1 + cpOffset * Math.sign(dx || 1);
    const cp1y = y1;
    const cp2x = x2 - cpOffset * Math.sign(dx || 1);
    const cp2y = y2;

    return `M ${x1} ${y1} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x2} ${y2}`;
  }
}
