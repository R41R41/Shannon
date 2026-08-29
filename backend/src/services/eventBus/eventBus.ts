import {
  Color,
  EventType,
  MemoryZone,
  TypedEvent,
} from '@shannon/common';
import { getWebNotificationHub } from '../web/webNotificationHub.js';
import { logger } from '../../utils/logger.js';

export class EventBus {
  // Internal storage uses the broad Event callback type for runtime flexibility.
  private listeners: Map<string, Array<(event: unknown) => void>> = new Map();

  /**
   * Type-safe subscribe: callback receives a TypedEvent whose `data`
   * is automatically narrowed based on the event type string.
   *
   * @example
   * eventBus.subscribe('discord:post_message', (event) => {
   *   // event.data is DiscordSendTextMessageInput (no cast needed)
   *   console.log(event.data.channelId);
   * });
   */
  subscribe<T extends EventType>(
    eventType: T,
    callback: (event: TypedEvent<T>) => void
  ): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, []);
    }
    // Cast needed: internal storage uses `unknown` while external API is generic
    const wrappedCallback = callback as (event: unknown) => void;
    this.listeners.get(eventType)?.push(wrappedCallback);

    return () => {
      const callbacks = this.listeners.get(eventType);
      if (callbacks) {
        this.listeners.set(
          eventType,
          callbacks.filter((cb) => cb !== wrappedCallback)
        );
      }
    };
  }

  /**
   * Type-safe publish: ensures the event data matches the expected
   * payload type for the given event type.
   * 各リスナーの例外を catch し、1つのリスナーの失敗が他に波及しないようにする。
   */
  publish<T extends EventType>(event: TypedEvent<T>): void {
    this.listeners.get(event.type)?.forEach((callback) => {
      if (
        !event.targetMemoryZones ||
        event.targetMemoryZones.includes(event.memoryZone)
      ) {
        try {
          const result: unknown = callback(event);
          if (result instanceof Promise) {
            result.catch((err) => {
              logger.error(`[EventBus] ${event.type} リスナーの非同期エラー: ${err instanceof Error ? err.message : err}`);
            });
          }
        } catch (err) {
          logger.error(`[EventBus] ${event.type} リスナーの同期エラー: ${err instanceof Error ? err.message : err}`);
        }
      }
    });
  }

  /**
   * ログを保存する
   * @param memoryZone メモリゾーン
   * @param color 色
   * @param content 内容
   * @param isSave 保存するかどうか
   */
  public async log(
    memoryZone: MemoryZone,
    color: Color,
    content: string,
    isSave: boolean = false
  ) {
    await getWebNotificationHub().log(memoryZone, color, content, isSave);
  }
}
