/**
 * Public Chat API — SSE endpoint for aiminelab.com
 *
 * POST /api/public/chat
 *   Body: { text, sessionId, adminToken? }
 *   Response: text/event-stream (SSE)
 *
 * SSE events:
 *   thinking  — { phase }
 *   emotion   — { emotion, parameters }
 *   task_update — { goal, strategy, status, hierarchicalSubTasks, currentSubTaskId }
 *   meta      — { assessment, suggestion, modelAction, consecutiveSuccesses, consecutiveFailures }
 *   reply     — { text }
 *   error     — { message }
 *   done      — {}
 */

import type { Express, Request, Response } from 'express';
import type { LLMService } from '../services/llm/client.js';
import type { EmotionType, TaskTreeState } from '@shannon/common';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { webAdapter } from '../services/common/adapters/index.js';
import { getEventBus } from '../services/eventBus/index.js';
import { createLogger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Rate limiting (in-memory, per IP, per day)
// ---------------------------------------------------------------------------

const logger = createLogger('Website:PublicChat');

const PUBLIC_CHAT_DAILY_LIMIT = parseInt(process.env.PUBLIC_CHAT_DAILY_LIMIT ?? '3', 10);
const PUBLIC_CHAT_ADMIN_TOKEN = process.env.PUBLIC_CHAT_ADMIN_TOKEN ?? '';

interface RateLimitEntry {
  count: number;
  date: string; // YYYY-MM-DD UTC
}

const rateLimitMap = new Map<string, RateLimitEntry>();

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function checkRateLimit(ip: string): { allowed: boolean; remaining: number } {
  const today = todayUTC();
  const entry = rateLimitMap.get(ip);

  if (!entry || entry.date !== today) {
    return { allowed: true, remaining: PUBLIC_CHAT_DAILY_LIMIT - 1 };
  }

  if (entry.count >= PUBLIC_CHAT_DAILY_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  return { allowed: true, remaining: PUBLIC_CHAT_DAILY_LIMIT - entry.count - 1 };
}

function incrementRateLimit(ip: string): void {
  const today = todayUTC();
  const entry = rateLimitMap.get(ip);

  if (!entry || entry.date !== today) {
    rateLimitMap.set(ip, { count: 1, date: today });
  } else {
    entry.count++;
  }
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sendSSE(res: Response, event: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerPublicRoutes(app: Express, llmService: LLMService): void {
  app.post('/api/public/chat', async (req: Request, res: Response) => {
    const { text, sessionId, adminToken, history } = req.body as {
      text?: string;
      sessionId?: string;
      adminToken?: string;
      history?: { role: 'user' | 'shannon'; text: string }[];
    };

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    if (text.length > 500) {
      res.status(400).json({ error: 'text must be 500 characters or less' });
      return;
    }

    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      ?? req.socket.remoteAddress
      ?? 'unknown';

    const isAdmin = PUBLIC_CHAT_ADMIN_TOKEN !== '' && adminToken === PUBLIC_CHAT_ADMIN_TOKEN;

    // Rate limit check (skip for admins)
    if (!isAdmin) {
      const { allowed, remaining } = checkRateLimit(ip);
      if (!allowed) {
        res.status(429).json({
          error: '本日の利用回数上限に達しました。また明日お話しましょう！',
          remaining: 0,
        });
        return;
      }
    }

    // --- Set up SSE response ---
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Increment rate limit after SSE connection is established (non-admin only)
    if (!isAdmin) {
      incrementRateLimit(ip);
    }

    const rateLimitInfo = isAdmin
      ? { remaining: -1 }
      : checkRateLimit(ip);

    // Send initial rate limit info
    sendSSE(res, 'rate_limit', {
      remaining: isAdmin ? -1 : rateLimitInfo.remaining + 1,
      isAdmin,
    });

    // --- Subscribe to EventBus events ---
    const eventBus = getEventBus();
    const sid = sessionId ?? 'public-default';
    const unsubscribers: (() => void)[] = [];

    // Emotion events
    const unsubEmotion = eventBus.subscribe('web:emotion', (event) => {
      const emotion = event.data as EmotionType;
      sendSSE(res, 'emotion', emotion);
    });
    unsubscribers.push(unsubEmotion);

    // Planning / Task tree events
    const unsubPlanning = eventBus.subscribe('web:planning', (event) => {
      const taskTree = event.data as TaskTreeState;
      sendSSE(res, 'task_update', taskTree);
    });
    unsubscribers.push(unsubPlanning);

    // Clean up on client disconnect
    req.on('close', () => {
      unsubscribers.forEach((unsub) => unsub());
    });

    try {
      // Send thinking phase: classify
      sendSSE(res, 'thinking', { phase: 'classify' });

      // Convert chat history to BaseMessage[] for the graph (last 10 messages)
      const legacyMessages = Array.isArray(history)
        ? history.slice(-10).map(m =>
            m.role === 'user'
              ? new HumanMessage(m.text)
              : new AIMessage(m.text)
          )
        : [];

      // Build envelope via webAdapter
      const currentTime = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      const envelope = webAdapter.toEnvelope({
        type: 'text',
        text: `${currentTime} ウェブ訪問者: ${text.trim()}`,
        senderName: 'ウェブ訪問者',
        sessionId: sid,
      });

      // Phase tracking via callbacks
      let lastPhase = 'classify';
      const sendPhaseIfNew = (phase: string) => {
        if (phase !== lastPhase) {
          lastPhase = phase;
          sendSSE(res, 'thinking', { phase });
        }
      };

      // Invoke the unified graph with conversation history
      const result = await llmService.invokeGraph(envelope, legacyMessages.length > 0 ? legacyMessages : undefined, {
        onToolStarting: (toolName, args) => {
          sendPhaseIfNew('execute');
          sendSSE(res, 'tool_start', { toolName, args });
        },
        onTaskTreeUpdate: (taskTree) => {
          sendPhaseIfNew('execute');
          sendSSE(res, 'task_update', taskTree);
        },
      });

      // Send emotion from final state if available
      if (result.emotion) {
        sendSSE(res, 'emotion', result.emotion);
      }

      // Send final task tree if available
      if (result.taskTree) {
        sendSSE(res, 'task_update', result.taskTree);
      }

      // Send thinking phase: format
      sendSSE(res, 'thinking', { phase: 'format' });

      // Extract the reply text
      // actionPlan.message（webDispatcher整形済み）を優先、
      // finalAnswer は思考ログの可能性があるので content: プレフィックスを除去
      const stripPrefix = (t: string) => t.replace(/^content:\s*/i, '').trim();
      const replyText = result.actionPlan?.message
        ?? (result.finalAnswer ? stripPrefix(result.finalAnswer) : null)
        ?? 'ごめんなさい、うまく返答できなかったみたい…もう一度聞いてくれる？';

      sendSSE(res, 'reply', { text: replyText });

      // Send meta-cognition info if available from trace
      const tracePhases = result.trace ?? [];
      sendSSE(res, 'meta', {
        phases: tracePhases,
        model: result.mode ?? 'unknown',
      });

    } catch (error) {
      logger.error('[PublicChat] Graph invocation error:', error);
      sendSSE(res, 'error', {
        message: 'シャノンの処理中にエラーが発生しました。もう一度試してみてね！',
      });
    } finally {
      // Cleanup EventBus subscriptions
      unsubscribers.forEach((unsub) => unsub());

      // Send done and end stream
      sendSSE(res, 'done', {});
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  // GET: Rate limit status check
  app.get('/api/public/chat/status', (req: Request, res: Response) => {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      ?? req.socket.remoteAddress
      ?? 'unknown';
    const { remaining } = checkRateLimit(ip);
    res.json({ remaining, limit: PUBLIC_CHAT_DAILY_LIMIT });
  });

  // POST: Admin token verification
  app.post('/api/public/chat/verify-admin', (req: Request, res: Response) => {
    const { adminToken } = req.body as { adminToken?: string };
    const valid = PUBLIC_CHAT_ADMIN_TOKEN !== '' && adminToken === PUBLIC_CHAT_ADMIN_TOKEN;
    res.json({ valid });
  });
}
