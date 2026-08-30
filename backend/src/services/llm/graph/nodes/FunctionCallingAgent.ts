import type { StructuredTool } from '@langchain/core/tools';
import { RunToolRegistry } from '../../../../modules/execution/runToolRegistry.js';
import { FunctionCallingSession } from './FunctionCallingSession.js';
import type { FunctionCallingAgentState, FlatFcaStateInput } from './fcaState.js';
import { normalizeFcaState } from './fcaState.js';
export type { FcaChannelAdapter, FcaComposition, FcaRunIdentity, FunctionCallingAgentState, FlatFcaStateInput } from './fcaState.js';
export { buildFcaState, normalizeFcaState } from './fcaState.js';

/** Reusable tool catalog/configuration. All per-invocation mutable state belongs to a session. */
export class FunctionCallingAgent {
    private readonly registry: RunToolRegistry<StructuredTool>;
    private routineManager: Parameters<FunctionCallingSession['setRoutineManager']>[0] = null;

    static get MODEL_NAME() { return FunctionCallingSession.MODEL_NAME; }
    static readonly MAX_ITERATIONS = FunctionCallingSession.MAX_ITERATIONS;
    static readonly MAX_ITERATIONS_EMERGENCY = FunctionCallingSession.MAX_ITERATIONS_EMERGENCY;
    static readonly LLM_TIMEOUT_MS_DEFAULT = FunctionCallingSession.LLM_TIMEOUT_MS_DEFAULT;
    static readonly MAX_TOTAL_TIME_MS = FunctionCallingSession.MAX_TOTAL_TIME_MS;

    constructor(tools: StructuredTool[]) { this.registry = new RunToolRegistry(tools); }
    addTools(tools: StructuredTool[]): void { this.registry.add(tools); }
    getToolNames(): string[] { return this.registry.names(); }
    createToolsForRun(): StructuredTool[] { return this.registry.createTools(); }
    setRoutineManager(manager: typeof this.routineManager): void { this.routineManager = manager; }

    createSession(): FunctionCallingSession {
        const session = new FunctionCallingSession(this.createToolsForRun());
        session.setRoutineManager(this.routineManager);
        return session;
    }

    async run(state: FunctionCallingAgentState | FlatFcaStateInput, signal?: AbortSignal) {
        signal?.throwIfAborted();
        return this.createSession().run(normalizeFcaState(state), signal);
    }
}
