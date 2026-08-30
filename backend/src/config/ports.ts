import { config } from './env.js';

export const PORTS = {
  HTTP_SERVER: config.ports.http,
  FRONTEND: config.ports.frontend,
  WEBSOCKET: {
    OPENAI: config.ports.ws.openai,
    VOICE: config.ports.ws.voice,
    MINECRAFT: config.ports.ws.minecraft,
    MONITORING: config.ports.ws.monitoring,
    SCHEDULE: config.ports.ws.schedule,
    STATUS: config.ports.ws.status,
    PLANNING: config.ports.ws.planning,
    SKILL: config.ports.ws.skill,
    AUTH: config.ports.ws.auth,
  },
} as const;
