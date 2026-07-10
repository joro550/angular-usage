import { Component, inject, signal } from '@angular/core';
import { ParserService } from '../services/parser.service';
import { StateService } from '../services/state.service';

type UploadState = 'idle' | 'parsing' | 'error';

@Component({
  selector: 'app-upload',
  standalone: true,
  templateUrl: './upload.component.html',
})
export class UploadComponent {
  private parser = inject(ParserService);
  private stateService = inject(StateService);

  readonly state = signal<UploadState>('idle');
  readonly isDraggingOver = signal(false);
  readonly errorMessage = signal('');

  readonly features = [
    {
      icon: '🗺️',
      title: 'Component Graph',
      desc: 'Draggable cards with relationship lines sized by usage',
    },
    {
      icon: '🔬',
      title: 'Deep Inspection',
      desc: 'Methods, signals, inputs, outputs and call graphs',
    },
    {
      icon: '⚡',
      title: 'Property Tracking',
      desc: 'See exactly which class properties each method touches',
    },
  ];

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDraggingOver.set(true);
  }

  onDragLeave(): void {
    this.isDraggingOver.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDraggingOver.set(false);
    const file = event.dataTransfer?.files[0];
    if (file) this.processFile(file);
  }

  onFileSelected(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) this.processFile(file);
  }

  private async processFile(file: File): Promise<void> {
    if (!file.name.endsWith('.zip')) {
      this.errorMessage.set('Please upload a .zip file');
      this.state.set('error');
      return;
    }

    this.state.set('parsing');

    try {
      const project = await this.parser.parseZip(file);

      if (project.components.length === 0) {
        this.errorMessage.set('No Angular components found in this ZIP');
        this.state.set('error');
        return;
      }

      this.stateService.loadProject(project);
    } catch (err) {
      console.error(err);
      this.errorMessage.set('Failed to parse project — check the console for details');
      this.state.set('error');
    }
  }
}
