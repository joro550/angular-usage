export type PropertyKind =
  | 'signal'
  | 'computed'
  | 'input'
  | 'output'
  | 'model'
  | 'inject'
  | 'regular';

export interface ClassProperty {
  name: string;
  kind: PropertyKind;
  dataType?: string;
}

export interface MethodNode {
  id: string;
  componentId: string;
  name: string;
  params: string;
  isAsync: boolean;
  isLifecycle: boolean;
  /** Names of methods within the same component this method calls */
  calledMethods: string[];
  /** Names of class properties this method reads or writes */
  touchedProperties: string[];
  body: string;
}

export interface ComponentNode {
  id: string;
  name: string;
  selector: string;
  filePath: string;
  /** IDs of components whose selectors appear in this component's template */
  usedComponents: string[];
  /** IDs of components that include this component in their template */
  usedBy: string[];
  methods: MethodNode[];
  properties: ClassProperty[];
  /** Initial layout position (pixels) */
  x: number;
  y: number;
}

export interface ParsedProject {
  components: ComponentNode[];
}
