import { Component, inject, signal } from '@angular/core';
import { ParserService } from '../services/parser.service';
import { StateService } from '../services/state.service';

type UploadState = 'idle' | 'parsing' | 'error';

@Component({
  selector: 'app-upload',
  standalone: true,
  template: `
    <div
      class="min-h-screen flex flex-col items-center justify-center bg-[#07070e] text-slate-200 p-8"
    >
      <!-- Logo / title -->
      <div class="mb-12 text-center">
        <div class="flex items-center justify-center gap-3 mb-3">
          <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
            <rect width="40" height="40" rx="10" fill="url(#grad)" />
            <path d="M10 28 L20 12 L30 28" stroke="white" stroke-width="2.5" stroke-linejoin="round" fill="none"/>
            <path d="M14 23 L26 23" stroke="white" stroke-width="2" stroke-linecap="round"/>
            <defs>
              <linearGradient id="grad" x1="0" y1="0" x2="40" y2="40">
                <stop offset="0%" stop-color="#6366f1"/>
                <stop offset="100%" stop-color="#8b5cf6"/>
              </linearGradient>
            </defs>
          </svg>
          <h1 class="text-3xl font-bold tracking-tight text-white">Angular Analyzer</h1>
        </div>
        <p class="text-slate-400 text-sm">
          Upload a zipped Angular project to visualize its component architecture
        </p>
      </div>

      <!-- Drop zone -->
      <div
        class="relative w-full max-w-xl rounded-2xl border-2 border-dashed transition-all duration-200 cursor-pointer"
        [class.border-indigo-500]="isDraggingOver()"
        [class.bg-indigo-500/5]="isDraggingOver()"
        [class.border-slate-700]="!isDraggingOver()"
        [class.bg-slate-900/40]="!isDraggingOver()"
        (dragover)="onDragOver($event)"
        (dragleave)="onDragLeave()"
        (drop)="onDrop($event)"
        (click)="fileInput.click()"
      >
        <input
          #fileInput
          type="file"
          accept=".zip"
          class="hidden"
          (change)="onFileSelected($event)"
        />

        <div class="flex flex-col items-center justify-center py-16 px-8 text-center">
          @if (state() === 'idle') {
            <div class="w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center mb-4">
              <svg class="w-8 h-8 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                  d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"/>
              </svg>
            </div>
            <p class="text-slate-300 font-medium mb-1">Drop your Angular project ZIP here</p>
            <p class="text-slate-500 text-sm">or click to browse</p>
            <div class="mt-6 flex gap-4 text-xs text-slate-600">
              <span class="flex items-center gap-1">
                <span class="w-1.5 h-1.5 rounded-full bg-green-500 inline-block"></span>
                *.component.ts
              </span>
              <span class="flex items-center gap-1">
                <span class="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block"></span>
                *.html templates
              </span>
              <span class="flex items-center gap-1">
                <span class="w-1.5 h-1.5 rounded-full bg-violet-500 inline-block"></span>
                signals & methods
              </span>
            </div>
          }

          @if (state() === 'parsing') {
            <div class="w-16 h-16 rounded-full bg-indigo-500/10 flex items-center justify-center mb-4">
              <svg class="w-8 h-8 text-indigo-400 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
                <path class="opacity-75" fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
            </div>
            <p class="text-indigo-300 font-medium">Parsing project…</p>
            <p class="text-slate-500 text-sm mt-1">Analysing components, methods & properties</p>
          }

          @if (state() === 'error') {
            <div class="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mb-4">
              <svg class="w-8 h-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                  d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
              </svg>
            </div>
            <p class="text-red-400 font-medium">{{ errorMessage() }}</p>
            <p class="text-slate-500 text-sm mt-1">Please try another file</p>
          }
        </div>
      </div>

      <!-- Features list -->
      <div class="mt-12 grid grid-cols-3 gap-6 max-w-2xl w-full">
        @for (feature of features; track feature.title) {
          <div class="bg-slate-900/40 rounded-xl p-4 border border-slate-800">
            <div class="text-lg mb-2">{{ feature.icon }}</div>
            <div class="text-sm font-medium text-slate-300 mb-1">{{ feature.title }}</div>
            <div class="text-xs text-slate-500">{{ feature.desc }}</div>
          </div>
        }
      </div>
    </div>
  `,
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
