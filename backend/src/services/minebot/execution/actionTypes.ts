export type ActionPhase = 'execute' | 'precondition' | 'search' | 'navigate' | 'dig'
  | 'wait_drop' | 'pickup' | 'confirm' | 'wait_external' | 'recovery';
export type ActionStatus = 'running' | 'waiting_external' | 'blocked' | 'cancelling'
  | 'completed' | 'failed' | 'cancelled';

/** Evidence, not an LLM conclusion. One identity survives nested skill calls. */
export interface ActionProgress {
  actionId: string;
  executionSessionId?: string;
  generation: number;
  sequence: number;
  capability: string;
  physical: boolean;
  phase: ActionPhase;
  status: ActionStatus;
  startedAt: number;
  updatedAt: number;
  lastProgressAt: number;
  elapsedMs: number;
  evidence: Record<string, unknown>;
}

export interface ActionTrace {
  actionId: string;
  generation: number;
  queueMs: number;
  phaseMs: Partial<Record<ActionPhase, number>>;
  events: ActionProgress[];
  quiescent: boolean;
  containment?: { cancelledAt: number; warningAt: number | null; settledAt: number | null; reclaimedAt?: number };
}
