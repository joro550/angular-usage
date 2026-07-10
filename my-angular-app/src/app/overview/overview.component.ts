import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
  ElementRef,
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

type InteractionState =
  | { kind: 'idle' }
  | { kind: 'pan'; startPanX: number; startPanY: number; startCX: number; startCY: number }
  | {
      kind: 'card';
      id: string;
      worldOffsetX: number;
      worldOffsetY: number;
      startCX: number;
      startCY: number;
      moved: boolean;
    };

const BASE_W = 200;
const BASE_H = 110;
const MAX_CARD_SCALE = 1.75;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 3;

@Component({
  selector: 'app-overview',
  standalone: true,
  host: { class: 'block w-full h-full' },
  templateUrl: './overview.component.html',
})
export class OverviewComponent {
  readonly state = inject(StateService);
  private readonly destroyRef = inject(DestroyRef);

  readonly containerEl = viewChild<ElementRef<HTMLDivElement>>('container');

  readonly project = computed(() => this.state.project()!);

  // Expose constants to template
  readonly MAX_ZOOM = MAX_ZOOM;
  readonly MIN_ZOOM = MIN_ZOOM;

  // Card positions in world space
  readonly positions = signal<Record<string, { x: number; y: number }>>({});
  readonly draggingId = signal<string | null>(null);

  // Viewport transform
  readonly pan = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  readonly zoom = signal<number>(1);
  readonly isPanning = signal(false);

  readonly transform = computed(() => {
    const { x, y } = this.pan();
    const z = this.zoom();
    return `translate(${x}px,${y}px) scale(${z})`;
  });

  readonly zoomPercent = computed(() => Math.round(this.zoom() * 100));

  // Animated infinite grid — SVG pattern offset matches pan % gridSize
  private readonly GRID_BASE = 60;
  readonly gridSize = computed(() => this.GRID_BASE * this.zoom());
  readonly gridX = computed(() => {
    const s = this.gridSize();
    return ((this.pan().x % s) + s) % s;
  });
  readonly gridY = computed(() => {
    const s = this.gridSize();
    return ((this.pan().y % s) + s) % s;
  });
  readonly gridPath = computed(
    () => `M ${this.gridSize()} 0 L 0 0 0 ${this.gridSize()}`,
  );

  // Search
  readonly searchQuery = signal('');
  private readonly matchingIds = computed<Set<string>>(() => {
    const q = this.searchQuery().toLowerCase().trim();
    if (!q) return new Set<string>();
    return new Set(
      this.project()
        .components.filter(
          c =>
            c.name.toLowerCase().includes(q) ||
            c.selector.toLowerCase().includes(q),
        )
        .map(c => c.id),
    );
  });
  readonly hasSearch = computed(() => this.searchQuery().trim().length > 0);
  readonly searchResultCount = computed(() => this.matchingIds().size);

  // Stats
  readonly totalEdges = computed(() =>
    this.project().components.reduce((s, c) => s + c.usedComponents.length, 0),
  );

  // Connection lines, recomputed reactively from positions
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
        result.push({
          id: `${comp.id}->${usedId}`,
          path: this.computePath(fromPos, fromDim, toPos, this.getCardDimensions(toComp)),
          opacity: 0.4 + Math.min(toComp.usedBy.length, 5) * 0.1,
        });
      }
    }
    return result;
  });

  // Interaction state machine (not reactive — mutated directly for perf)
  private interaction: InteractionState = { kind: 'idle' };

  constructor() {
    // Re-initialise when project changes
    effect(() => {
      const proj = this.state.project();
      if (!proj) return;
      const init: Record<string, { x: number; y: number }> = {};
      for (const c of proj.components) init[c.id] = { x: c.x, y: c.y };
      this.positions.set(init);
      this.searchQuery.set('');
      this.pan.set({ x: 0, y: 0 });
      this.zoom.set(1);
      setTimeout(() => this.fitToScreen(), 0);
    });

    // Pan to centre on search results when query changes
    effect(() => {
      const ids = this.matchingIds();
      if (ids.size === 0) return;

      setTimeout(() => {
        const pos = untracked(() => this.positions());
        const proj = untracked(() => this.project());
        const el = this.containerEl()?.nativeElement;
        if (!el) return;
        const rect = el.getBoundingClientRect();

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const comp of proj.components) {
          if (!ids.has(comp.id)) continue;
          const p = pos[comp.id];
          if (!p) continue;
          const dim = this.getCardDimensions(comp);
          minX = Math.min(minX, p.x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x + dim.w);
          maxY = Math.max(maxY, p.y + dim.h);
        }
        if (!isFinite(minX)) return;

        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const z = this.zoom();
        this.pan.set({ x: rect.width / 2 - cx * z, y: rect.height / 2 - cy * z });
      }, 0);
    });

    // Register non-passive wheel listener so preventDefault() works
    afterNextRender(() => {
      const el = this.containerEl()?.nativeElement;
      if (!el) return;

      const handler = (e: WheelEvent) => {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        this.applyZoom(
          e.deltaY < 0 ? 1.12 : 1 / 1.12,
          e.clientX - rect.left,
          e.clientY - rect.top,
        );
      };

      el.addEventListener('wheel', handler, { passive: false });
      this.destroyRef.onDestroy(() => el.removeEventListener('wheel', handler));
    });
  }

  // ---------------------------------------------------------------------------
  // Coordinate helpers
  // ---------------------------------------------------------------------------

  private screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const el = this.containerEl()?.nativeElement;
    if (!el) return { x: clientX, y: clientY };
    const rect = el.getBoundingClientRect();
    const z = this.zoom();
    const p = this.pan();
    return {
      x: (clientX - rect.left - p.x) / z,
      y: (clientY - rect.top - p.y) / z,
    };
  }

  // ---------------------------------------------------------------------------
  // Pointer events
  // ---------------------------------------------------------------------------

  onBackgroundPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const p = this.pan();
    this.interaction = {
      kind: 'pan',
      startPanX: p.x,
      startPanY: p.y,
      startCX: event.clientX,
      startCY: event.clientY,
    };
    this.isPanning.set(true);
  }

  startDrag(event: PointerEvent, id: string): void {
    if (event.button !== 0) return;
    event.stopPropagation(); // prevent background pan handler from also firing

    const pos = this.positions()[id] ?? { x: 0, y: 0 };
    const world = this.screenToWorld(event.clientX, event.clientY);
    this.interaction = {
      kind: 'card',
      id,
      worldOffsetX: world.x - pos.x,
      worldOffsetY: world.y - pos.y,
      startCX: event.clientX,
      startCY: event.clientY,
      moved: false,
    };
    this.draggingId.set(id);
  }

  onPointerMove(event: PointerEvent): void {
    const ia = this.interaction;

    if (ia.kind === 'pan') {
      this.pan.set({
        x: ia.startPanX + (event.clientX - ia.startCX),
        y: ia.startPanY + (event.clientY - ia.startCY),
      });
    } else if (ia.kind === 'card') {
      if (
        Math.abs(event.clientX - ia.startCX) > 4 ||
        Math.abs(event.clientY - ia.startCY) > 4
      ) {
        ia.moved = true;
      }
      const world = this.screenToWorld(event.clientX, event.clientY);
      this.positions.update(p => ({
        ...p,
        [ia.id]: { x: world.x - ia.worldOffsetX, y: world.y - ia.worldOffsetY },
      }));
    }
  }

  onPointerUp(event: PointerEvent): void {
    const ia = this.interaction;
    if (ia.kind === 'card' && !ia.moved) {
      const comp = this.project().components.find(c => c.id === ia.id);
      if (comp) this.state.selectComponent(comp);
    }
    this.interaction = { kind: 'idle' };
    this.isPanning.set(false);
    this.draggingId.set(null);
  }

  // ---------------------------------------------------------------------------
  // Zoom
  // ---------------------------------------------------------------------------

  private applyZoom(factor: number, pivotX: number, pivotY: number): void {
    const cur = this.zoom();
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cur * factor));
    const ratio = next / cur;
    const p = this.pan();
    this.pan.set({
      x: pivotX - (pivotX - p.x) * ratio,
      y: pivotY - (pivotY - p.y) * ratio,
    });
    this.zoom.set(next);
  }

  zoomIn(): void {
    const el = this.containerEl()?.nativeElement;
    if (!el) return;
    const r = el.getBoundingClientRect();
    this.applyZoom(1.25, r.width / 2, r.height / 2);
  }

  zoomOut(): void {
    const el = this.containerEl()?.nativeElement;
    if (!el) return;
    const r = el.getBoundingClientRect();
    this.applyZoom(0.8, r.width / 2, r.height / 2);
  }

  fitToScreen(): void {
    const el = this.containerEl()?.nativeElement;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const proj = this.project();
    if (!proj?.components.length) return;

    const pos = this.positions();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const comp of proj.components) {
      const p = pos[comp.id];
      if (!p) continue;
      const dim = this.getCardDimensions(comp);
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + dim.w);
      maxY = Math.max(maxY, p.y + dim.h);
    }
    if (!isFinite(minX)) return;

    const PAD = 80;
    const worldW = maxX - minX + PAD * 2;
    const worldH = maxY - minY + PAD * 2;
    const newZoom = Math.max(MIN_ZOOM, Math.min(1, rect.width / worldW, rect.height / worldH));

    this.zoom.set(newZoom);
    this.pan.set({
      x: (rect.width - worldW * newZoom) / 2 - (minX - PAD) * newZoom,
      y: (rect.height - worldH * newZoom) / 2 - (minY - PAD) * newZoom,
    });
  }

  resetLayout(): void {
    const proj = this.project();
    const init: Record<string, { x: number; y: number }> = {};
    for (const c of proj.components) init[c.id] = { x: c.x, y: c.y };
    this.positions.set(init);
    setTimeout(() => this.fitToScreen(), 0);
  }

  // ---------------------------------------------------------------------------
  // Search helpers
  // ---------------------------------------------------------------------------

  isSearchMatch(comp: ComponentNode): boolean {
    if (!this.hasSearch()) return true;
    return this.matchingIds().has(comp.id);
  }

  onSearchInput(event: Event): void {
    this.searchQuery.set((event.target as HTMLInputElement).value);
  }

  clearSearch(): void {
    this.searchQuery.set('');
  }

  // ---------------------------------------------------------------------------
  // Card appearance
  // ---------------------------------------------------------------------------

  getCardDimensions(comp: ComponentNode): CardDimensions {
    const scale = 1 + (Math.min(comp.usedBy.length, 6) / 6) * (MAX_CARD_SCALE - 1);
    return {
      w: Math.round(BASE_W * scale),
      h: Math.round(BASE_H * scale),
      fontSize: scale > 1.3 ? 14 : 12,
    };
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
    if (n === 0) return 'linear-gradient(90deg,#6366f1,#8b5cf6)';
    if (n <= 2) return 'linear-gradient(90deg,#6366f1,#a855f7)';
    if (n <= 4) return 'linear-gradient(90deg,#8b5cf6,#d946ef)';
    return 'linear-gradient(90deg,#a855f7,#ec4899)';
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
    const sign = Math.sign(dx) || 1;
    const cp = Math.min(Math.abs(dx) * 0.5, 180) + 40;
    return `M ${x1} ${y1} C ${x1 + cp * sign} ${y1}, ${x2 - cp * sign} ${y2}, ${x2} ${y2}`;
  }
}
