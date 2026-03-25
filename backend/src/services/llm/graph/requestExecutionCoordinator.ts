import type { RequestEnvelope } from '@shannon/common';
import { logger } from '../../../utils/logger.js';

type TaskRunner<T> = () => Promise<T>;

/**
 * Serializes graph execution for lanes that must stay ordered while still
 * allowing unrelated requests to run concurrently.
 *
 * Phase 1-B: 緊急リクエストは先行タスクの完了を待たず、
 * AbortController で現在実行中のタスクを中断して即座に実行する。
 */
export class RequestExecutionCoordinator {
  private static instance: RequestExecutionCoordinator;

  private lanes = new Map<string, Promise<unknown>>();

  /** レーンごとの現在実行中タスクの AbortController */
  private laneAbortControllers = new Map<string, AbortController>();

  static getInstance(): RequestExecutionCoordinator {
    if (!RequestExecutionCoordinator.instance) {
      RequestExecutionCoordinator.instance = new RequestExecutionCoordinator();
    }
    return RequestExecutionCoordinator.instance;
  }

  /**
   * 通常リクエスト: レーン内で直列化して実行する。
   * signal が返されるので、緊急割り込み時に中断される可能性がある。
   */
  async run<T>(envelope: RequestEnvelope, task: TaskRunner<T>): Promise<T> {
    const isEmergency = envelope.tags.includes('emergency');

    if (isEmergency) {
      return this.runEmergency(envelope, task);
    }

    return this.runNormal(envelope, task);
  }

  /**
   * レーンの現在実行中タスクを中断するための AbortController を取得。
   * FCA や MinebotTaskRuntime から利用可能。
   */
  getAbortController(laneKey: string): AbortController | undefined {
    return this.laneAbortControllers.get(laneKey);
  }

  /**
   * 通常実行: レーン内で前のタスクを待つ。
   */
  private async runNormal<T>(envelope: RequestEnvelope, task: TaskRunner<T>): Promise<T> {
    const laneKey = this.getLaneKey(envelope);
    const previous = this.lanes.get(laneKey) ?? Promise.resolve();

    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lanePromise = previous.then(() => current);
    this.lanes.set(laneKey, lanePromise);

    await previous.catch(() => {});

    // AbortController を登録（緊急割り込みで中断される可能性）
    const abortController = new AbortController();
    this.laneAbortControllers.set(laneKey, abortController);

    try {
      return await task();
    } finally {
      release();
      this.laneAbortControllers.delete(laneKey);
      const active = this.lanes.get(laneKey);
      if (active === lanePromise) {
        this.lanes.delete(laneKey);
      }
    }
  }

  /**
   * 緊急実行: 同一レーンの先行タスクを abort し、キューをバイパスして即座に実行。
   * 効果: -0〜30秒（先行タスク待ち解消）
   */
  private async runEmergency<T>(envelope: RequestEnvelope, task: TaskRunner<T>): Promise<T> {
    const laneKey = this.getLaneKey(envelope);

    // 同一レーンの現在実行中タスクを中断
    const existingAbort = this.laneAbortControllers.get(laneKey);
    if (existingAbort) {
      logger.warn(`🚨 [Coordinator] 緊急プリエンプション: レーン "${laneKey}" の先行タスクを中断`);
      existingAbort.abort();
    }

    // 前のタスクの完了を待たず、直接実行
    // (先行タスクは abort で終了するが、Promise チェーンは残るので新しいチェーンを開始)
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.lanes.set(laneKey, current);

    const abortController = new AbortController();
    this.laneAbortControllers.set(laneKey, abortController);

    try {
      return await task();
    } finally {
      release();
      this.laneAbortControllers.delete(laneKey);
      const active = this.lanes.get(laneKey);
      if (active === current) {
        this.lanes.delete(laneKey);
      }
    }
  }

  private getLaneKey(envelope: RequestEnvelope): string {
    if (envelope.tags.includes('self_mod_apply')) {
      return 'self-mod:apply';
    }

    if (envelope.channel === 'minecraft') {
      const worldKey = envelope.minecraft?.worldId
        ?? envelope.minecraft?.serverId
        ?? envelope.minecraft?.serverName
        ?? envelope.threadId;
      return `minecraft-world:${worldKey}`;
    }

    return `thread:${envelope.threadId}`;
  }
}
