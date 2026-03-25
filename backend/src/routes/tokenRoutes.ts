import fs from 'fs';
import path from 'path';
import type { Express } from 'express';
import { tokenTracker } from '../services/llm/utils/tokenTracker.js';

export function registerTokenRoutes(app: Express): void {
  // -----------------------------------------------------------------
  // トークン使用量 API
  // -----------------------------------------------------------------
  app.get('/api/tokens/session', (_req, res) => {
    res.json(tokenTracker.getSessionStats());
  });

  app.get('/api/tokens/daily', async (_req, res) => {
    const days = parseInt(_req.query.days as string) || 7;
    res.json(await tokenTracker.getDailyStats(days));
  });

  app.get('/api/tokens/today', async (_req, res) => {
    const daily = await tokenTracker.getDailyStats(1);
    const todayTotal = daily.reduce((sum: number, d: { totalTokens?: number }) => sum + (d.totalTokens || 0), 0);
    const todayCalls = daily.reduce((sum: number, d: { calls?: number }) => sum + (d.calls || 0), 0);
    res.json({ totalTokens: todayTotal, callCount: todayCalls, details: daily });
  });

  // -----------------------------------------------------------------
  // 投稿スケジュール API
  // -----------------------------------------------------------------
  app.get('/api/twitter/schedule', (_req, res) => {
    try {
      const schedulePath = path.resolve('saves/auto_post_daily_schedule.json');
      if (fs.existsSync(schedulePath)) {
        const data = JSON.parse(fs.readFileSync(schedulePath, 'utf-8'));
        res.json(data);
      } else {
        res.json({ date: '', times: [], postedCount: 0 });
      }
    } catch {
      res.json({ date: '', times: [], postedCount: 0 });
    }
  });

  // -----------------------------------------------------------------
  // Minebot ワールド知識 API
  // -----------------------------------------------------------------
  app.get('/api/minebot/knowledge/stats', async (_req, res) => {
    try {
      const { WorldKnowledgeService } = await import('../services/minebot/knowledge/WorldKnowledgeService.js');
      const service = WorldKnowledgeService.getInstance();
      res.json(await service.getStats());
    } catch { res.json({}); }
  });

  app.get('/api/minebot/knowledge/nearby', async (req, res) => {
    try {
      const x = parseInt(req.query.x as string) || 0;
      const y = parseInt(req.query.y as string) || 64;
      const z = parseInt(req.query.z as string) || 0;
      const radius = parseInt(req.query.radius as string) || 64;
      const { WorldKnowledgeService } = await import('../services/minebot/knowledge/WorldKnowledgeService.js');
      const service = WorldKnowledgeService.getInstance();
      const context = await service.buildContextForPosition({ x, y, z }, radius);
      res.json({ context });
    } catch { res.json({ context: '' }); }
  });

  app.get('/api/minebot/skills/metrics', async (_req, res) => {
    try {
      const { skillMetrics } = await import('../services/minebot/knowledge/SkillMetrics.js');
      res.json(skillMetrics.getAll());
    } catch { res.json({}); }
  });
}
