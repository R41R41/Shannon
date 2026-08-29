import type { Schedule, SchedulerInput } from '@shannon/common';

export interface SchedulerPort {
  getSchedule(input: SchedulerInput): Promise<void>;
  callSchedule(input: SchedulerInput): Promise<void>;
  listSchedules(): Schedule[];
}

let schedulerPort: SchedulerPort | null = null;

export function registerSchedulerPort(port: SchedulerPort): void {
  if (schedulerPort) throw new Error('SchedulerPort already registered');
  schedulerPort = port;
}

export function getSchedulerPort(): SchedulerPort {
  if (!schedulerPort) throw new Error('SchedulerPort is not registered');
  return schedulerPort;
}

export function clearSchedulerPort(): void {
  schedulerPort = null;
}
