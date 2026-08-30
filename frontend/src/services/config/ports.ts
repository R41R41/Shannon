export const isTest = import.meta.env.MODE === "test";
export const isDev = import.meta.env.MODE === "dev";
const useDirectWsPorts = isDev || import.meta.env.VITE_WS_DIRECT_PORTS === 'true';

const protocol = window.location.protocol === "https:" ? "https:" : "http:";
const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";

const hostname = window.location.hostname;
const host = window.location.host;

const devWsPorts = {
  openai: 15010,
  monitoring: 15011,
  status: 15013,
  skill: 15016,
  auth: 15017,
  schedule: 15018,
  planning: 15019,
} as const;

const prodDirectWsPorts = {
  openai: 5021,
  monitoring: 5022,
  status: 5023,
  schedule: 5024,
  planning: 5025,
  skill: 5027,
  auth: 5028,
} as const;

function buildDirectWebSocketUrls(ports: Record<string, number>) {
  return {
    OPENAI: `${wsProtocol}//${hostname}:${ports.openai}`,
    MONITORING: `${wsProtocol}//${hostname}:${ports.monitoring}`,
    SCHEDULER: `${wsProtocol}//${hostname}:${ports.schedule}`,
    STATUS: `${wsProtocol}//${hostname}:${ports.status}`,
    PLANNING: `${wsProtocol}//${hostname}:${ports.planning}`,
    SKILL: `${wsProtocol}//${hostname}:${ports.skill}`,
    AUTH: `${wsProtocol}//${hostname}:${ports.auth}`,
  };
}

function buildWebSocketUrls() {
  if (useDirectWsPorts) {
    return buildDirectWebSocketUrls(isDev ? devWsPorts : prodDirectWsPorts);
  }
  return {
    OPENAI: `${wsProtocol}//${host}/ws/openai`,
    MONITORING: `${wsProtocol}//${host}/ws/monitoring`,
    SCHEDULER: `${wsProtocol}//${host}/ws/scheduler`,
    STATUS: `${wsProtocol}//${host}/ws/status`,
    PLANNING: `${wsProtocol}//${host}/ws/planning`,
    SKILL: `${wsProtocol}//${host}/ws/skill`,
    AUTH: `${wsProtocol}//${host}/ws/auth`,
  };
}

export const URLS = {
  HTTP_SERVER: `${protocol}//${host}`,
  FRONTEND: `${protocol}//${host}`,
  WEBSOCKET: buildWebSocketUrls(),
} as const;

console.log("Environment:", import.meta.env.MODE);
console.log("isDev:", isDev);
console.log("WebSocket URLs:", URLS.WEBSOCKET);
