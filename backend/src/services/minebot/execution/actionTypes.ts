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
  /** Continue contracts (8): when the lock was taken, when the first effective motor operation was sent, and how many were (the root action's own). */
  lockAt?: number; firstMotorAt?: number; motorOps?: number;
  /** Continue contracts (4): this action's place in the count of owners (a root action that moves the body takes the next number). */
  holderSeq?: number;
}
