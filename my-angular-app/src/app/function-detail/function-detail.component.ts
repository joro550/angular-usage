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
  templateUrl: './function-detail.component.html',
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
