export interface NamedTool { readonly name: string }
type RunScopedTool<T> = T & { createForRun?: () => T };
const CONTEXT_SETTERS = ['setContext', 'setMemoryAgent', 'setMemoryPort', 'setBlackboard', 'setBot'] as const;

/** Catalog of reusable definitions. Context-bearing tools must explicitly create fresh instances. */
export class RunToolRegistry<T extends NamedTool> {
  private readonly tools = new Map<string, T>();

  constructor(tools: readonly T[]) { this.add(tools); }

  add(tools: readonly T[]): void {
    // Validate the whole registration before changing the catalog.
    for (const tool of tools) {
      if (!tool.name.trim()) throw new Error('Tool name is required');
      if (CONTEXT_SETTERS.some(key => typeof (tool as Record<string, unknown>)[key] === 'function')
          && typeof (tool as RunScopedTool<T>).createForRun !== 'function') {
        throw new Error(`Context-bearing tool requires createForRun: ${tool.name}`);
      }
    }
    for (const tool of tools) if (!this.tools.has(tool.name)) this.tools.set(tool.name, tool);
  }

  names(): string[] { return [...this.tools.keys()]; }

  createTools(): T[] {
    return [...this.tools.values()].map(tool => {
      const factory = (tool as RunScopedTool<T>).createForRun;
      if (!factory) return tool; // Reviewed stateless tools/services can be reused.
      const instance = factory.call(tool);
      if (instance === tool || !instance || instance.name !== tool.name) {
        throw new Error(`Invalid run-scoped tool factory: ${tool.name}`);
      }
      return instance;
    });
  }
}
