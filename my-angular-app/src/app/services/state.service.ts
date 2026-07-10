import { Injectable, signal, computed } from '@angular/core';
import { ComponentNode, MethodNode, ParsedProject } from '../models/project.model';

export type ViewMode = 'upload' | 'overview' | 'component' | 'function';

@Injectable({ providedIn: 'root' })
export class StateService {
  readonly project = signal<ParsedProject | null>(null);
  readonly viewMode = signal<ViewMode>('upload');
  readonly selectedComponentId = signal<string | null>(null);
  readonly selectedMethodId = signal<string | null>(null);

  readonly selectedComponent = computed<ComponentNode | null>(() => {
    const id = this.selectedComponentId();
    const proj = this.project();
    if (!id || !proj) return null;
    return proj.components.find(c => c.id === id) ?? null;
  });

  readonly selectedMethod = computed<MethodNode | null>(() => {
    const comp = this.selectedComponent();
    const id = this.selectedMethodId();
    if (!comp || !id) return null;
    return comp.methods.find(m => m.id === id) ?? null;
  });

  loadProject(project: ParsedProject): void {
    this.project.set(project);
    this.selectedComponentId.set(null);
    this.selectedMethodId.set(null);
    this.viewMode.set('overview');
  }

  selectComponent(component: ComponentNode): void {
    this.selectedComponentId.set(component.id);
    this.selectedMethodId.set(null);
    this.viewMode.set('component');
  }

  selectMethod(method: MethodNode): void {
    this.selectedMethodId.set(method.id);
    this.viewMode.set('function');
  }

  backToOverview(): void {
    this.selectedComponentId.set(null);
    this.selectedMethodId.set(null);
    this.viewMode.set('overview');
  }

  backToComponent(): void {
    this.selectedMethodId.set(null);
    this.viewMode.set('component');
  }

  resetToUpload(): void {
    this.project.set(null);
    this.selectedComponentId.set(null);
    this.selectedMethodId.set(null);
    this.viewMode.set('upload');
  }
}
