import { createLogger } from '../../../utils/logger.js';
import { CONFIG } from '../config/MinebotConfig.js';
import type { ConstantSkill, InstantSkill } from './skills.js';

const log = createLogger('Minebot:Types');

export class InstantSkills {
  skills: InstantSkill[];
  constructor() {
    this.skills = [];
  }
  addSkill(skill: InstantSkill) {
    this.skills.push(skill);
  }
  getSkill(name: string): InstantSkill | undefined {
    return this.skills.find((skill) => skill.skillName === name);
  }
  getSkills(): InstantSkill[] {
    return this.skills;
  }
  hasSkill(name: string): boolean {
    return this.skills.some((skill) => skill.skillName === name);
  }
  removeSkill(name: string): boolean {
    const idx = this.skills.findIndex((skill) => skill.skillName === name);
    if (idx === -1) return false;
    this.skills.splice(idx, 1);
    return true;
  }
}

// タスクキューのエントリー型
export type TaskQueueEntry = {
  skill: ConstantSkill;
  startTime: number;
  args: any[];
};

// タスクキューの状態型
export type TaskQueueState = {
  isProcessing: boolean;
  queue: TaskQueueEntry[];
  currentTask: TaskQueueEntry | null;
};

// 優先度付きキュー（ヒープベース）
class PriorityQueue {
  private heap: TaskQueueEntry[];

  constructor() {
    this.heap = [];
  }

  // 親ノードのインデックスを取得
  private parentIndex(index: number): number {
    return Math.floor((index - 1) / 2);
  }

  // 左の子ノードのインデックスを取得
  private leftChildIndex(index: number): number {
    return 2 * index + 1;
  }

  // 右の子ノードのインデックスを取得
  private rightChildIndex(index: number): number {
    return 2 * index + 2;
  }

  // ノードを上に移動（優先度が高い場合）
  private bubbleUp(index: number) {
    const parent = this.parentIndex(index);
    if (index > 0 && this.heap[parent].skill.priority < this.heap[index].skill.priority) {
      [this.heap[parent], this.heap[index]] = [this.heap[index], this.heap[parent]];
      this.bubbleUp(parent);
    }
  }

  // ノードを下に移動（優先度が低い場合）
  private bubbleDown(index: number) {
    const left = this.leftChildIndex(index);
    const right = this.rightChildIndex(index);
    let largest = index;

    if (left < this.heap.length && this.heap[left].skill.priority > this.heap[largest].skill.priority) {
      largest = left;
    }

    if (right < this.heap.length && this.heap[right].skill.priority > this.heap[largest].skill.priority) {
      largest = right;
    }

    if (largest !== index) {
      [this.heap[index], this.heap[largest]] = [this.heap[largest], this.heap[index]];
      this.bubbleDown(largest);
    }
  }

  // タスクの追加（O(log n)）
  push(task: TaskQueueEntry) {
    this.heap.push(task);
    this.bubbleUp(this.heap.length - 1);
  }

  // タスクの取り出し（O(log n)）
  pop(): TaskQueueEntry | undefined {
    if (this.heap.length === 0) return undefined;

    const result = this.heap[0];
    const last = this.heap.pop()!;

    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }

    return result;
  }

  // キューの長さを取得
  length(): number {
    return this.heap.length;
  }

  // キューを配列として取得
  toArray(): TaskQueueEntry[] {
    return [...this.heap];
  }

  // キューをクリア
  clear() {
    this.heap = [];
  }
}

export class ConstantSkills {
  skills: ConstantSkill[];
  private taskQueue: PriorityQueue;
  private isProcessing: boolean;
  private currentTask: TaskQueueEntry | null;
  private readonly MAX_QUEUE_SIZE = CONFIG.MAX_QUEUE_SIZE;
  private readonly TASK_TIMEOUT = CONFIG.TASK_TIMEOUT;
  private processInterval: NodeJS.Timeout | null;

  constructor() {
    this.skills = [];
    this.taskQueue = new PriorityQueue();
    this.isProcessing = false;
    this.currentTask = null;
    this.processInterval = null;
    this.startProcessing();
  }

  // 定期的なタスク処理を開始
  private startProcessing() {
    if (this.processInterval) return;

    this.processInterval = setInterval(() => {
      if (!this.isProcessing && this.taskQueue.length() > 0) {
        this.processNextTask();
      }
    }, 100); // 100msごとにチェック
  }

  // 定期的なタスク処理を停止
  private stopProcessing() {
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
    }
  }

  // タスクをキューに追加
  private addToQueue(skill: ConstantSkill, args: any[] = []) {
    const entry: TaskQueueEntry = {
      skill,
      startTime: Date.now(),
      args
    };

    this.taskQueue.push(entry);

    // キューサイズの制限
    if (this.taskQueue.length() > this.MAX_QUEUE_SIZE) {
      // 優先度の低いタスクを削除
      const tasks = this.taskQueue.toArray();
      tasks.sort((a, b) => a.skill.priority - b.skill.priority);
      this.taskQueue.clear();
      tasks.slice(0, this.MAX_QUEUE_SIZE).forEach(task => this.taskQueue.push(task));
    }

  }

  // 次のタスクを処理a
  private async processNextTask() {
    if (this.isProcessing || this.taskQueue.length() === 0) return;

    this.isProcessing = true;
    this.currentTask = this.taskQueue.pop()!;

    try {
      // タイムアウト処理
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Task timeout')), this.TASK_TIMEOUT);
      });

      // タスク実行
      await Promise.race([
        this.currentTask.skill.run(...this.currentTask.args),
        timeoutPromise
      ]);
    } catch (error) {
      log.error('タスク実行エラー', error);
    } finally {
      this.isProcessing = false;
      this.currentTask = null;
    }
  }

  // スキルの実行を要求
  async requestExecution(skill: ConstantSkill, args: any[] = []) {
    this.addToQueue(skill, args);
  }

  // キューのクリア
  clearQueue() {
    this.taskQueue.clear();
    this.isProcessing = false;
    this.currentTask = null;
  }

  // デストラクタ
  destroy() {
    this.stopProcessing();
    this.clearQueue();
  }

  // 既存のメソッド
  addSkill(skill: ConstantSkill) {
    this.skills.push(skill);
  }

  getSkill(name: string): ConstantSkill | undefined {
    return this.skills.find((skill) => skill.skillName === name);
  }

  getSkills(): ConstantSkill[] {
    return this.skills;
  }
  hasSkill(name: string): boolean {
    return this.skills.some((skill) => skill.skillName === name);
  }
  removeSkill(name: string): boolean {
    const idx = this.skills.findIndex((skill) => skill.skillName === name);
    if (idx === -1) return false;
    const skill = this.skills[idx];
    skill.status = false;
    this.skills.splice(idx, 1);
    return true;
  }

  // キューの状態を取得
  getQueueState(): TaskQueueState {
    return {
      isProcessing: this.isProcessing,
      queue: this.taskQueue.toArray(),
      currentTask: this.currentTask
    };
  }
}
