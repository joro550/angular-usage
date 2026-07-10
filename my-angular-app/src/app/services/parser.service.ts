import { Injectable } from '@angular/core';
import JSZip from 'jszip';
import {
  ClassProperty,
  ComponentNode,
  MethodNode,
  ParsedProject,
  PropertyKind,
} from '../models/project.model';

const LIFECYCLE_HOOKS = new Set([
  'ngOnInit',
  'ngOnDestroy',
  'ngOnChanges',
  'ngAfterViewInit',
  'ngAfterViewChecked',
  'ngAfterContentInit',
  'ngAfterContentChecked',
  'ngDoCheck',
]);

const CONTROL_KEYWORDS = new Set([
  'if',
  'else',
  'for',
  'while',
  'switch',
  'try',
  'catch',
  'finally',
  'do',
  'return',
  'new',
  'delete',
  'typeof',
  'instanceof',
  'void',
  'throw',
  'await',
  'yield',
  'class',
  'interface',
  'type',
  'enum',
  'get',
  'set',
  'super',
]);

@Injectable({ providedIn: 'root' })
export class ParserService {
  async parseZip(file: File): Promise<ParsedProject> {
    const zip = new JSZip();
    const loaded = await zip.loadAsync(file);

    // Read all non-binary text files, skip node_modules and .git
    const fileMap = new Map<string, string>();
    const reads: Promise<void>[] = [];

    loaded.forEach((relativePath, entry) => {
      if (
        entry.dir ||
        relativePath.includes('node_modules/') ||
        relativePath.includes('.git/') ||
        relativePath.includes('dist/')
      )
        return;

      const ext = relativePath.split('.').pop() ?? '';
      if (!['ts', 'html', 'htm'].includes(ext)) return;

      reads.push(
        entry
          .async('string')
          .then(content => { fileMap.set(relativePath, content); })
          .catch(() => {}),
      );
    });

    await Promise.all(reads);

    // Locate .component.ts files (exclude spec files)
    const componentPaths = [...fileMap.keys()].filter(
      p => p.endsWith('.component.ts') && !p.includes('.spec.'),
    );

    // First pass: parse each component file independently
    const components: ComponentNode[] = [];
    const selectorToId = new Map<string, string>();

    // We carry template metadata through a side-channel to avoid polluting the model
    const templateMeta = new Map<
      string,
      { inlineTemplate?: string; templateUrl?: string }
    >();

    for (const path of componentPaths) {
      const content = fileMap.get(path)!;
      const result = this.parseComponentFile(content, path);
      if (!result) continue;

      const { component, inlineTemplate, templateUrl } = result;
      components.push(component);
      if (component.selector) selectorToId.set(component.selector, component.id);
      templateMeta.set(component.id, { inlineTemplate, templateUrl });
    }

    // Second pass: resolve templates and build usedComponents
    for (const comp of components) {
      const meta = templateMeta.get(comp.id);
      if (!meta) continue;

      let templateContent = meta.inlineTemplate ?? '';

      if (!templateContent && meta.templateUrl) {
        templateContent = this.resolveTemplate(
          fileMap,
          comp.filePath,
          meta.templateUrl,
        );
      }

      if (templateContent) {
        const usedSelectors = this.extractSelectorsFromHtml(templateContent);
        for (const sel of usedSelectors) {
          const usedId = selectorToId.get(sel);
          if (usedId && usedId !== comp.id && !comp.usedComponents.includes(usedId)) {
            comp.usedComponents.push(usedId);
          }
        }
      }
    }

    // Third pass: build reverse (usedBy) relationships
    for (const comp of components) {
      for (const usedId of comp.usedComponents) {
        const used = components.find(c => c.id === usedId);
        if (used && !used.usedBy.includes(comp.id)) {
          used.usedBy.push(comp.id);
        }
      }
    }

    // Compute force-directed layout
    this.computeLayout(components);

    return { components };
  }

  // ---------------------------------------------------------------------------
  // Component file parsing
  // ---------------------------------------------------------------------------

  private parseComponentFile(
    content: string,
    filePath: string,
  ): {
    component: ComponentNode;
    inlineTemplate?: string;
    templateUrl?: string;
  } | null {
    if (!content.includes('@Component')) return null;

    const className = this.extractClassName(content);
    if (!className) return null;

    const id = this.makeId(filePath);
    const selector =
      this.extractSelector(content) || this.classNameToSelector(className);
    const templateUrl = this.extractTemplateUrl(content) ?? undefined;
    const inlineTemplate = this.extractInlineTemplate(content) ?? undefined;

    const classBody = this.extractClassBody(content);
    const properties = this.extractProperties(classBody);
    const propNames = properties.map(p => p.name);
    const methods = this.extractMethods(classBody, id, propNames);

    // Re-fill calledMethods now that we have all method names
    const allMethodNames = methods.map(m => m.name);
    for (const method of methods) {
      method.calledMethods = this.findMethodCalls(method.body, allMethodNames);
    }

    return {
      component: {
        id,
        name: className,
        selector,
        filePath,
        usedComponents: [],
        usedBy: [],
        methods,
        properties,
        x: 0,
        y: 0,
      },
      inlineTemplate,
      templateUrl,
    };
  }

  private extractClassName(content: string): string | null {
    const m = content.match(/export\s+(?:default\s+)?class\s+(\w+)/);
    return m?.[1] ?? null;
  }

  private extractSelector(content: string): string {
    const m = content.match(/selector\s*:\s*['"`]([^'"`\n]+)['"`]/);
    return m?.[1] ?? '';
  }

  private extractTemplateUrl(content: string): string | null {
    const m = content.match(/templateUrl\s*:\s*['"`]([^'"`\n]+)['"`]/);
    return m?.[1] ?? null;
  }

  private extractInlineTemplate(content: string): string | null {
    // Find @Component decorator block then look for template: `...`
    const compIdx = content.indexOf('@Component');
    if (compIdx === -1) return null;

    const braceIdx = content.indexOf('{', compIdx);
    if (braceIdx === -1) return null;

    const decoratorBody = this.sliceBraceBody(content, braceIdx + 1);

    const tmplIdx = decoratorBody.indexOf('template:');
    if (tmplIdx === -1) return null;

    const afterColon = decoratorBody.slice(tmplIdx + 9).trimStart();

    if (afterColon[0] === '`') {
      let i = 1;
      while (i < afterColon.length) {
        if (afterColon[i] === '\\') {
          i += 2;
          continue;
        }
        if (afterColon[i] === '`') break;
        // skip ${...} expressions
        if (afterColon[i] === '$' && afterColon[i + 1] === '{') {
          i += 2;
          let d = 1;
          while (i < afterColon.length && d > 0) {
            if (afterColon[i] === '{') d++;
            else if (afterColon[i] === '}') d--;
            i++;
          }
          continue;
        }
        i++;
      }
      return afterColon.slice(1, i);
    }

    if (afterColon[0] === '"' || afterColon[0] === "'") {
      const q = afterColon[0];
      let i = 1;
      while (i < afterColon.length && afterColon[i] !== q) {
        if (afterColon[i] === '\\') i++;
        i++;
      }
      return afterColon.slice(1, i);
    }

    return null;
  }

  /** Extract the content between the outermost braces of the class body. */
  private extractClassBody(content: string): string {
    const classMatch = content.match(
      /class\s+\w+(?:\s+extends\s+[\w<>, ]+)?(?:\s+implements\s+[\w<>, ]+)?\s*\{/,
    );
    if (!classMatch || classMatch.index === undefined) return '';
    const bodyStart = classMatch.index + classMatch[0].length;
    return this.sliceBraceBody(content, bodyStart);
  }

  /**
   * Given content and an index AFTER the opening `{`, returns everything up to
   * (but not including) the matching `}`, correctly skipping strings/comments.
   */
  private sliceBraceBody(content: string, start: number): string {
    let depth = 1;
    let i = start;

    while (i < content.length && depth > 0) {
      const ch = content[i];

      if (ch === '{') {
        depth++;
        i++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) return content.slice(start, i);
        i++;
      } else if (ch === '/' && content[i + 1] === '/') {
        // line comment
        while (i < content.length && content[i] !== '\n') i++;
      } else if (ch === '/' && content[i + 1] === '*') {
        i += 2;
        while (i < content.length && !(content[i] === '*' && content[i + 1] === '/'))
          i++;
        i += 2;
      } else if (ch === '`') {
        i++;
        while (i < content.length && content[i] !== '`') {
          if (content[i] === '\\') {
            i += 2;
            continue;
          }
          if (content[i] === '$' && content[i + 1] === '{') {
            i += 2;
            let d = 1;
            while (i < content.length && d > 0) {
              if (content[i] === '{') d++;
              else if (content[i] === '}') d--;
              i++;
            }
            continue;
          }
          i++;
        }
        i++;
      } else if (ch === '"') {
        i++;
        while (i < content.length && content[i] !== '"') {
          if (content[i] === '\\') i++;
          i++;
        }
        i++;
      } else if (ch === "'") {
        i++;
        while (i < content.length && content[i] !== "'") {
          if (content[i] === '\\') i++;
          i++;
        }
        i++;
      } else {
        i++;
      }
    }

    return content.slice(start, i);
  }

  // ---------------------------------------------------------------------------
  // Property extraction
  // ---------------------------------------------------------------------------

  private extractProperties(classBody: string): ClassProperty[] {
    const props: ClassProperty[] = [];
    const seen = new Set<string>();

    const add = (name: string, kind: PropertyKind) => {
      if (!seen.has(name)) {
        seen.add(name);
        props.push({ name, kind });
      }
    };

    // signal / computed / output / model / linkedSignal / toSignal / input / input.required
    const signalPat =
      /(?:^|\n)[ \t]*(?:(?:private|protected|public|readonly|override)\s+)*(\w+)\s*=\s*(signal|computed|output|model|linkedSignal|toSignal|input(?:\.required)?)\s*(?:<[^>]*>)?\s*\(/gm;

    let m: RegExpExecArray | null;
    while ((m = signalPat.exec(classBody)) !== null) {
      const kind = (m[2].startsWith('input') ? 'input' : m[2]) as PropertyKind;
      add(m[1], kind);
    }

    // inject(Service)
    const injectPat =
      /(?:^|\n)[ \t]*(?:(?:private|protected|public|readonly)\s+)*(\w+)\s*=\s*inject\s*(?:<[^>]*>)?\s*\(/gm;
    while ((m = injectPat.exec(classBody)) !== null) add(m[1], 'inject');

    // constructor parameter injection: constructor(private foo: Type)
    const ctorMatch = classBody.match(/constructor\s*\(([^)]*)\)/);
    if (ctorMatch) {
      const paramPat = /(?:private|protected|public|readonly)\s+(\w+)\s*:/g;
      while ((m = paramPat.exec(ctorMatch[1])) !== null) add(m[1], 'inject');
    }

    // Regular typed properties: private/protected/public name: Type = ...
    const regularPat =
      /(?:^|\n)[ \t]*(?:(?:private|protected|public|readonly|override)\s+)+(\w+)(?:\s*[!?])?(?:\s*:\s*[\w<>[\]|&\s,.()']+)?\s*(?:=|;)/gm;
    while ((m = regularPat.exec(classBody)) !== null) {
      if (!CONTROL_KEYWORDS.has(m[1])) add(m[1], 'regular');
    }

    return props;
  }

  // ---------------------------------------------------------------------------
  // Method extraction
  // ---------------------------------------------------------------------------

  private extractMethods(
    classBody: string,
    componentId: string,
    propNames: string[],
  ): MethodNode[] {
    const methods: MethodNode[] = [];
    const seen = new Set<string>();

    const makeMethod = (
      name: string,
      params: string,
      isAsync: boolean,
      body: string,
    ): MethodNode => ({
      id: `${componentId}_${name}`,
      componentId,
      name,
      params: params.trim(),
      isAsync,
      isLifecycle: LIFECYCLE_HOOKS.has(name),
      calledMethods: [], // filled later
      touchedProperties: this.findPropertyAccesses(body, propNames),
      body,
    });

    // Standard methods: [modifiers] name([params])[: ReturnType] {
    const methodPat =
      /(?:^|\n)[ \t]*(?:(?:async|override|abstract|static|protected|private|public)\s+)*(\w+)\s*\(([^)]*)\)\s*(?::\s*[^{;=\n<>]+?)?\s*\{/gm;
    let m: RegExpExecArray | null;

    while ((m = methodPat.exec(classBody)) !== null) {
      const name = m[1];
      if (CONTROL_KEYWORDS.has(name) || seen.has(name)) continue;

      const bodyStart = m.index + m[0].length;
      const body = this.sliceBraceBody(classBody, bodyStart);
      const isAsync = /\basync\b/.test(m[0]);

      seen.add(name);
      methods.push(makeMethod(name, m[2], isAsync, body));
    }

    // Arrow-function class fields: [modifiers] name = [async] ([params]) => {
    const arrowPat =
      /(?:^|\n)[ \t]*(?:(?:private|protected|public|readonly|override)\s+)*(\w+)\s*=\s*(async\s+)?\([^)]*\)\s*(?::\s*[^=>\n]+)?\s*=>\s*\{/gm;

    while ((m = arrowPat.exec(classBody)) !== null) {
      const name = m[1];
      if (CONTROL_KEYWORDS.has(name) || seen.has(name)) continue;

      const bodyStart = m.index + m[0].length;
      const body = this.sliceBraceBody(classBody, bodyStart);
      const isAsync = !!m[2];

      seen.add(name);
      methods.push(makeMethod(name, '', isAsync, body));
    }

    return methods;
  }

  // ---------------------------------------------------------------------------
  // Body analysis helpers
  // ---------------------------------------------------------------------------

  private findMethodCalls(body: string, allMethodNames: string[]): string[] {
    const calls = new Set<string>();
    const pat = /\bthis\.(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(body)) !== null) {
      if (allMethodNames.includes(m[1])) calls.add(m[1]);
    }
    return [...calls];
  }

  private findPropertyAccesses(body: string, propNames: string[]): string[] {
    const accesses = new Set<string>();
    const pat = /\bthis\.(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(body)) !== null) {
      if (propNames.includes(m[1])) accesses.add(m[1]);
    }
    return [...accesses];
  }

  // ---------------------------------------------------------------------------
  // Template parsing
  // ---------------------------------------------------------------------------

  private extractSelectorsFromHtml(html: string): string[] {
    const selectors = new Set<string>();
    // Custom elements must contain at least one hyphen
    const pat = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s>/]/g;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(html)) !== null) selectors.add(m[1]);
    return [...selectors];
  }

  private resolveTemplate(
    fileMap: Map<string, string>,
    componentPath: string,
    templateUrl: string,
  ): string {
    // Build relative path
    const dir = componentPath.split('/').slice(0, -1).join('/');
    const rel = templateUrl.replace(/^\.\//, '');
    const full = dir ? `${dir}/${rel}` : rel;

    if (fileMap.has(full)) return fileMap.get(full)!;

    // Fallback: match by filename anywhere in the map
    const filename = templateUrl.split('/').pop() ?? '';
    for (const [path, content] of fileMap) {
      if (path.endsWith(`/${filename}`) || path === filename) return content;
    }

    return '';
  }

  // ---------------------------------------------------------------------------
  // Force-directed layout
  // ---------------------------------------------------------------------------

  private computeLayout(components: ComponentNode[]): void {
    const n = components.length;
    if (n === 0) return;

    // Card size mirrors OverviewComponent.getCardDimensions() (BASE_W=200, BASE_H=110, MAX_SCALE=1.75)
    const cardW = (c: ComponentNode) => Math.round(200 * (1 + (Math.min(c.usedBy.length, 6) / 6) * 0.75));
    const cardH = (c: ComponentNode) => Math.round(110 * (1 + (Math.min(c.usedBy.length, 6) / 6) * 0.75));

    const W = 5000, H = 4000, PAD = 350;

    // Initial positions: evenly spaced circle, radius scales with n
    const dynamicRadius = Math.max(Math.min(W, H) * 0.38, n * 80);
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2;
      components[i].x = W / 2 + Math.cos(angle) * dynamicRadius + (Math.random() - 0.5) * 40;
      components[i].y = H / 2 + Math.sin(angle) * dynamicRadius + (Math.random() - 0.5) * 40;
    }

    const fx = new Float64Array(n);
    const fy = new Float64Array(n);

    for (let iter = 0; iter < 350; iter++) {
      fx.fill(0); fy.fill(0);

      // Size-aware repulsion: blow up strongly when cards would overlap
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dx = components[j].x - components[i].x;
          const dy = components[j].y - components[i].y;
          const dist2 = dx * dx + dy * dy + 1;
          const dist = Math.sqrt(dist2);

          // Minimum centre-to-centre distance that keeps the cards from overlapping
          const minDist = (cardW(components[i]) + cardW(components[j])) / 2 + 60;

          let strength: number;
          if (dist < minDist) {
            // Very strong push-apart when overlapping
            strength = 2_000_000 / dist2;
          } else {
            strength = Math.min(300_000 / dist2, 3000);
          }

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
          const strength = dist * 0.0015;
          const nx = dx / dist, ny = dy / dist;
          fx[i] += nx * strength; fy[i] += ny * strength;
          fx[j] -= nx * strength; fy[j] -= ny * strength;
        }
      }

      // Apply with cooling schedule
      const damp = Math.max(0.3, 0.88 - iter * 0.0015);
      for (let i = 0; i < n; i++) {
        components[i].x = Math.max(PAD, Math.min(W - PAD, components[i].x + fx[i] * damp));
        components[i].y = Math.max(PAD, Math.min(H - PAD, components[i].y + fy[i] * damp));
      }
    }

    // ── Post-simulation: AABB collision resolution ────────────────────────────
    // Push apart any remaining overlapping pairs (accounts for non-circular card shapes).
    const GAP = 30; // minimum pixel gap between card edges
    for (let pass = 0; pass < 80; pass++) {
      let anyOverlap = false;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const wi = cardW(components[i]), hi = cardH(components[i]);
          const wj = cardW(components[j]), hj = cardH(components[j]);
          const reqX = (wi + wj) / 2 + GAP; // required centre-to-centre on X
          const reqY = (hi + hj) / 2 + GAP; // required centre-to-centre on Y

          const dx = components[j].x - components[i].x;
          const dy = components[j].y - components[i].y;

          if (Math.abs(dx) < reqX && Math.abs(dy) < reqY) {
            anyOverlap = true;
            // Resolve along whichever axis has the smaller overlap ratio
            const overlapX = reqX - Math.abs(dx);
            const overlapY = reqY - Math.abs(dy);
            if (overlapX / reqX < overlapY / reqY) {
              const push = overlapX / 2 + 1;
              const sign = dx >= 0 ? 1 : -1;
              components[i].x -= sign * push;
              components[j].x += sign * push;
            } else {
              const push = overlapY / 2 + 1;
              const sign = dy >= 0 ? 1 : -1;
              components[i].y -= sign * push;
              components[j].y += sign * push;
            }
          }
        }
      }
      if (!anyOverlap) break;
    }
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  private makeId(filePath: string): string {
    return filePath.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
  }

  private classNameToSelector(name: string): string {
    // MyComponent -> app-my
    const base = name
      .replace(/Component$/, '')
      .replace(/([A-Z])/g, (_, l, i) => (i > 0 ? '-' : '') + l.toLowerCase());
    return base.startsWith('-') ? `app${base}` : `app-${base}`;
  }
}
