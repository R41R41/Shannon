import type {
  Color,
  ILog,
  MemoryZone,
  OpenAITextInput,
  SchedulerOutput,
  ServiceOutput,
  SkillInfo,
  StatusAgentInput,
  TaskTreeState,
} from '@shannon/common';
import Log from '../../models/Log.js';
import { logger } from '../../utils/logger.js';

type Unsub = () => void;

export type WebPlanningPayload = TaskTreeState & {
  sessionId?: string;
  conversationId?: string;
  taskId?: string;
};

export type WebPostMessagePayload = OpenAITextInput & {
  sessionId?: string;
  conversationId?: string;
};

/** In-process Web UI notifications. Not a global authorization bus. */
export class WebNotificationHub {
  private readonly logListeners = new Set<(entry: ILog) => void>();
  private readonly planningListeners = new Set<(payload: WebPlanningPayload) => void>();
  private readonly postMessageListeners = new Set<(payload: WebPostMessagePayload) => void>();
  private readonly statusListeners = new Set<(payload: StatusAgentInput | ServiceOutput) => void>();
  private readonly scheduleListeners = new Set<(payload: SchedulerOutput) => void>();
  private readonly skillListeners = new Set<(payload: SkillInfo[]) => void>();

  onLog(listener: (entry: ILog) => void): Unsub {
    this.logListeners.add(listener);
    return () => { this.logListeners.delete(listener); };
  }

  onPlanning(listener: (payload: WebPlanningPayload) => void): Unsub {
    this.planningListeners.add(listener);
    return () => { this.planningListeners.delete(listener); };
  }

  onPostMessage(listener: (payload: WebPostMessagePayload) => void): Unsub {
    this.postMessageListeners.add(listener);
    return () => { this.postMessageListeners.delete(listener); };
  }

  onStatus(listener: (payload: StatusAgentInput | ServiceOutput) => void): Unsub {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  onPostSchedule(listener: (payload: SchedulerOutput) => void): Unsub {
    this.scheduleListeners.add(listener);
    return () => { this.scheduleListeners.delete(listener); };
  }

  onSkill(listener: (payload: SkillInfo[]) => void): Unsub {
    this.skillListeners.add(listener);
    return () => { this.skillListeners.delete(listener); };
  }

  emitPlanning(payload: WebPlanningPayload): void {
    for (const listener of this.planningListeners) {
      try { listener(payload); } catch (err) {
        logger.error(`[WebNotificationHub] planning listener error: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  emitPostMessage(payload: WebPostMessagePayload): void {
    for (const listener of this.postMessageListeners) {
      try { listener(payload); } catch (err) {
        logger.error(`[WebNotificationHub] post_message listener error: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  emitStatus(payload: StatusAgentInput | ServiceOutput): void {
    for (const listener of this.statusListeners) {
      try { listener(payload); } catch (err) {
        logger.error(`[WebNotificationHub] status listener error: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  emitPostSchedule(payload: SchedulerOutput): void {
    for (const listener of this.scheduleListeners) {
      try { listener(payload); } catch (err) {
        logger.error(`[WebNotificationHub] schedule listener error: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  emitSkill(payload: SkillInfo[]): void {
    for (const listener of this.skillListeners) {
      try { listener(payload); } catch (err) {
        logger.error(`[WebNotificationHub] skill listener error: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  async log(
    memoryZone: MemoryZone,
    color: Color,
    content: string,
    isSave: boolean = false,
    sessionId?: string,
  ): Promise<void> {
    const logEntry: ILog = {
      timestamp: new Date(),
      memoryZone,
      color,
      content,
      ...(sessionId ? { sessionId } : {}),
    };
    logger.info(content.length > 150 ? `${content.slice(0, 150)}...` : content, color);
    if (isSave) {
      try {
        await Log.create(logEntry);
        const logCount = await Log.countDocuments();
        if (logCount > 10000) {
          const logsToDelete = logCount - 5000;
          const oldestLogs = await Log.find().sort({ timestamp: 1 }).limit(logsToDelete);
          if (oldestLogs.length > 0) {
            await Log.deleteMany({ _id: { $in: oldestLogs.map(row => row._id) } });
            logger.info(`${logsToDelete}件の古いログを削除しました`);
          }
        }
      } catch (error) {
        logger.error('Error saving log', error);
      }
    }
    this.emitLog(logEntry);
  }

  emitLog(entry: ILog): void {
    for (const listener of this.logListeners) {
      try { listener(entry); } catch (err) {
        logger.error(`[WebNotificationHub] log listener error: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}

let hubInstance: WebNotificationHub | null = null;

export function getWebNotificationHub(): WebNotificationHub {
  if (!hubInstance) hubInstance = new WebNotificationHub();
  return hubInstance;
}

export function clearWebNotificationHub(): void {
  hubInstance = null;
}

export function emitWebServiceStatus(payload: StatusAgentInput | ServiceOutput): void {
  getWebNotificationHub().emitStatus(payload);
}
