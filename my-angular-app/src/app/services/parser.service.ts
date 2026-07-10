import { Injectable } from '@angular/core';
import JSZip from 'jszip';
import { ComponentNode, MethodNode, ParsedProject } from '../models/project.model';
import { parseAngularComponent, findThisAccesses } from './ts-class-parser';

@Injectable({ providedIn: 'root' })
export class ParserService {

  async parseZip(file: File): Promise<ParsedProject> {
    const zip = new JSZip();
    const loaded = await zip.loadAsync(file);

    // Read all relevant text files, skipping generated and binary directories
    const fileMap = new Map<string, string>();
    const reads: Promise<void>[] = [];

    loaded.forEach((path, entry) => {
      if (
        entry.dir ||
        path.includes('node_modules/') ||
        path.includes('.git/') ||
        path.includes('dist/')
      ) return;
      const ext = path.split('.').pop() ?? '';
      if (!['ts', 'html', 'htm'].includes(ext)) return;
      reads.push(
        entry.async('string')
          .then(content => { fileMap.set(path, content); })
          .catch(() => {}),
      );
    });

    await Promise.all(reads);

    // ── Pass 1: parse each .component.ts file ────────────────────────────────
    const components: ComponentNode[] = [];
    const selectorToId = new Map<string, string>(); // selector → component id
    // Side-channel for template resolution
    const templateMeta = new Map<string, { url?: string; inline?: string }>();

    const componentPaths = [...fileMap.keys()].filter(
      p => p.endsWith('.component.ts') && !p.includes('.spec.'),
    );

    for (const filePath of componentPaths) {
      const src = fileMap.get(filePath)!;
      const parsed = parseAngularComponent(src);
      if (!parsed) continue;

      const id = makeId(filePath);

      // Build method nodes — we need all method names before filling calledMethods
      const allMethodNames = parsed.methods.map(m => m.name);
      const methodNodes: MethodNode[] = parsed.methods.map(m => {
        const accesses = findThisAccesses(m.body);
        const propNameSet = new Set(parsed.properties.map(p => p.name));
        return {
          id: `${id}_${m.name}`,
          componentId: id,
          name: m.name,
          params: m.params,
          isAsync: m.isAsync,
          isLifecycle: m.isLifecycle,
          // calledMethods filled below after all names are collected
          calledMethods: [],
          touchedProperties: [...new Set(
            accesses.filter(a => propNameSet.has(a.name)).map(a => a.name),
          )],
          body: m.body,
        } satisfies MethodNode;
      });

      // Now fill calledMethods using the full method name list
      const methodNameSet = new Set(allMethodNames);
      for (const method of methodNodes) {
        const accesses = findThisAccesses(method.body);
        method.calledMethods = [...new Set(
          accesses.filter(a => a.isCall && methodNameSet.has(a.name)).map(a => a.name),
        )];
      }

      const component: ComponentNode = {
        id,
        name: parsed.className,
        selector: parsed.selector,
        filePath,
        usedComponents: [],
        usedBy: [],
        methods: methodNodes,
        properties: parsed.properties,
        x: 0,
        y: 0,
      };

      components.push(component);
      if (component.selector) selectorToId.set(component.selector, id);
      templateMeta.set(id, { url: parsed.templateUrl ?? undefined, inline: parsed.inlineTemplate ?? undefined });
    }

    // ── Pass 2: resolve templates → build usedComponents ────────────────────
    for (const comp of components) {
      const meta = templateMeta.get(comp.id);
      if (!meta) continue;

      let template = meta.inline ?? '';
      if (!template && meta.url) {
        template = resolveTemplate(fileMap, comp.filePath, meta.url);
      }

      if (template) {
        for (const sel of extractSelectorsFromHtml(template)) {
          const usedId = selectorToId.get(sel);
          if (usedId && usedId !== comp.id && !comp.usedComponents.includes(usedId)) {
            comp.usedComponents.push(usedId);
          }
        }
      }
    }

    // ── Pass 3: build reverse usedBy relationships ───────────────────────────
    for (const comp of components) {
      for (const usedId of comp.usedComponents) {
        const used = components.find(c => c.id === usedId);
        if (used && !used.usedBy.includes(comp.id)) {
          used.usedBy.push(comp.id);
        }
      }
    }

    // ── Pass 4: force-directed layout ────────────────────────────────────────
    computeLayout(components);

    return { components };
  }
}

// ─── Template parsing ─────────────────────────────────────────────────────────

/** Extract all custom-element tag names from an HTML string. */
function extractSelectorsFromHtml(html: string): string[] {
  const selectors = new Set<string>();
  const pat = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s>/]/g;
  let m: RegExpExecArray | null;
  while ((m = pat.exec(html)) !== null) selectors.add(m[1]);
  return [...selectors];
}

function resolveTemplate(
  fileMap: Map<string, string>,
  componentPath: string,
  templateUrl: string,
): string {
  const dir = componentPath.split('/').slice(0, -1).join('/');
  const rel = templateUrl.replace(/^\.\//, '');
  const full = dir ? `${dir}/${rel}` : rel;
  if (fileMap.has(full)) return fileMap.get(full)!;

  const filename = templateUrl.split('/').pop() ?? '';
  for (const [path, content] of fileMap) {
    if (path.endsWith(`/${filename}`) || path === filename) return content;
  }
  return '';
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function makeId(filePath: string): string {
  return filePath.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
}

// ─── Force-directed layout ────────────────────────────────────────────────────

function computeLayout(components: ComponentNode[]): void {
  const n = components.length;
  if (n === 0) return;

  // Card dimensions mirror OverviewComponent.getCardDimensions()
  const cardW = (c: ComponentNode) => Math.round(200 * (1 + (Math.min(c.usedBy.length, 6) / 6) * 0.75));
  const cardH = (c: ComponentNode) => Math.round(110 * (1 + (Math.min(c.usedBy.length, 6) / 6) * 0.75));

  const W = 5000, H = 4000, PAD = 350;
  const dynamicRadius = Math.max(Math.min(W, H) * 0.38, n * 80);

  // Initial circle layout, jittered to break symmetry
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    components[i].x = W / 2 + Math.cos(a) * dynamicRadius + (Math.random() - 0.5) * 40;
    components[i].y = H / 2 + Math.sin(a) * dynamicRadius + (Math.random() - 0.5) * 40;
  }

  const fx = new Float64Array(n);
  const fy = new Float64Array(n);

  for (let iter = 0; iter < 350; iter++) {
    fx.fill(0); fy.fill(0);

    // Size-aware repulsion — much stronger when cards overlap
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = components[j].x - components[i].x;
        const dy = components[j].y - components[i].y;
        const dist2 = dx * dx + dy * dy + 1;
        const dist = Math.sqrt(dist2);
        const minDist = (cardW(components[i]) + cardW(components[j])) / 2 + 60;
        const strength = dist < minDist ? 2_000_000 / dist2 : Math.min(300_000 / dist2, 3000);
        const nx = dx / dist, ny = dy / dist;
        fx[i] -= nx * strength; fy[i] -= ny * strength;
        fx[j] += nx * strength; fy[j] += ny * strength;
      }
    }

    // Weak edge attraction
    for (let i = 0; i < n; i++) {
      for (const usedId of components[i].usedComponents) {
        const j = components.findIndex(c => c.id === usedId);
        if (j < 0) continue;
        const dx = components[j].x - components[i].x;
        const dy = components[j].y - components[i].y;
        const dist = Math.sqrt(dx * dx + dy * dy) + 1;
        const s = dist * 0.0015;
        const nx = dx / dist, ny = dy / dist;
        fx[i] += nx * s; fy[i] += ny * s;
        fx[j] -= nx * s; fy[j] -= ny * s;
      }
    }

    // Apply with cooling
    const damp = Math.max(0.3, 0.88 - iter * 0.0015);
    for (let i = 0; i < n; i++) {
      components[i].x = Math.max(PAD, Math.min(W - PAD, components[i].x + fx[i] * damp));
      components[i].y = Math.max(PAD, Math.min(H - PAD, components[i].y + fy[i] * damp));
    }
  }

  // Post-simulation AABB collision resolution
  const GAP = 30;
  for (let pass = 0; pass < 80; pass++) {
    let anyOverlap = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const wi = cardW(components[i]), hi = cardH(components[i]);
        const wj = cardW(components[j]), hj = cardH(components[j]);
        const reqX = (wi + wj) / 2 + GAP;
        const reqY = (hi + hj) / 2 + GAP;
        const dx = components[j].x - components[i].x;
        const dy = components[j].y - components[i].y;
        if (Math.abs(dx) < reqX && Math.abs(dy) < reqY) {
          anyOverlap = true;
          if (Math.abs(dx) / reqX > Math.abs(dy) / reqY) {
            const push = (reqX - Math.abs(dx)) / 2 + 1;
            const sign = dx >= 0 ? 1 : -1;
            components[i].x -= sign * push; components[j].x += sign * push;
          } else {
            const push = (reqY - Math.abs(dy)) / 2 + 1;
            const sign = dy >= 0 ? 1 : -1;
            components[i].y -= sign * push; components[j].y += sign * push;
          }
        }
      }
    }
    if (!anyOverlap) break;
  }
}
