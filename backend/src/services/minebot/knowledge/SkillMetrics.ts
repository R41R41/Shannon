/**
 * スキル実行メトリクスの収集と集計。
 * 成功率・平均実行時間・エラーパターンを記録し、
 * LLMのプランニング精度向上とダッシュボード表示に活用する。
 */
import mongoose, { Schema, Document } from 'mongoose';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:SkillMetrics');

export interface ISkillExecution extends Document {
  serverName: string;
  skillName: string;
  args: string[];
  success: boolean;
  durationMs: number;
  error: string | null;
  timestamp: Date;
}

const SkillExecutionSchema = new Schema<ISkillExecution>({
  serverName: { type: String, required: true, index: true },
  skillName: { type: String, required: true, index: true },
  args: [String],
  success: { type: Boolean, required: true },
  durationMs: { type: Number, required: true },
  error: { type: String, default: null },
  timestamp: { type: Date, default: Date.now, index: true },
});

SkillExecutionSchema.index({ timestamp: 1 }, { expireAfterSeconds: 604800 }); // 7 days

let SkillExecution: mongoose.Model<ISkillExecution>;
try { SkillExecution = mongoose.model<ISkillExecution>('SkillExecution'); }
catch { SkillExecution = mongoose.model<ISkillExecution>('SkillExecution', SkillExecutionSchema); }

// インメモリ集計（高速アクセス用）
const inMemoryMetrics = new Map<string, {
  executionCount: number;
  successCount: number;
  totalDurationMs: number;
  maxDurationMs: number;
  lastError: string | null;
  timeoutCount: number;
  durations: number[];
}>();

function getOrCreate(skillName: string) {
  if (!inMemoryMetrics.has(skillName)) {
    inMemoryMetrics.set(skillName, {
      executionCount: 0, successCount: 0, totalDurationMs: 0,
      maxDurationMs: 0, lastError: null, timeoutCount: 0, durations: [],
    });
  }
  return inMemoryMetrics.get(skillName)!;
}

export const skillMetrics = {
  async record(serverName: string, skillName: string, args: string[], success: boolean, durationMs: number, error: string | null = null): Promise<void> {
    const m = getOrCreate(skillName);
    m.executionCount++;
    if (success) m.successCount++;
    m.totalDurationMs += durationMs;
    m.maxDurationMs = Math.max(m.maxDurationMs, durationMs);
    if (error) {
      m.lastError = error;
      if (error.includes('タイムアウト')) m.timeoutCount++;
    }
    m.durations.push(durationMs);
    if (m.durations.length > 100) m.durations.shift();

    try {
      if (mongoose.connection.readyState === 1) {
        await SkillExecution.create({ serverName, skillName, args: args.slice(0, 5), success, durationMs, error, timestamp: new Date() });
      }
    } catch {}
  },

  getAll(): Record<string, {
    executionCount: number;
    successRate: number;
    avgDurationMs: number;
    p95DurationMs: number;
    maxDurationMs: number;
    lastError: string | null;
    timeoutCount: number;
  }> {
    const result: Record<string, {
      executionCount: number;
      successRate: number;
      avgDurationMs: number;
      p95DurationMs: number;
      maxDurationMs: number;
      lastError: string | null;
      timeoutCount: number;
    }> = {};
    for (const [name, m] of inMemoryMetrics) {
      const sorted = [...m.durations].sort((a, b) => a - b);
      const p95Idx = Math.floor(sorted.length * 0.95);
      result[name] = {
        executionCount: m.executionCount,
        successRate: m.executionCount > 0 ? Math.round((m.successCount / m.executionCount) * 100) : 0,
        avgDurationMs: m.executionCount > 0 ? Math.round(m.totalDurationMs / m.executionCount) : 0,
        p95DurationMs: sorted[p95Idx] || 0,
        maxDurationMs: m.maxDurationMs,
        lastError: m.lastError,
        timeoutCount: m.timeoutCount,
      };
    }
    return result;
  },

  getLowSuccessSkills(threshold = 70): string[] {
    const result: string[] = [];
    for (const [name, m] of inMemoryMetrics) {
      if (m.executionCount >= 3) {
        const rate = (m.successCount / m.executionCount) * 100;
        if (rate < threshold) result.push(`${name}(成功率${Math.round(rate)}%)`);
      }
    }
    return result;
  },
};
