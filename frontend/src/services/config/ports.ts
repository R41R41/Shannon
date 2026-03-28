export const isTest = import.meta.env.MODE === "test";
export const isDev = import.meta.env.MODE === "dev";

const protocol = window.location.protocol === "https:" ? "https:" : "http:";
const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";

const hostname = window.location.hostname;
const host = window.location.host;

// dev: 直接ポート接続（nginx なし）
// prod: パスベース（nginx プロキシ経由）
const devWsPorts = {
  openai: 15010,
  monitoring: 15011,
  status: 15013,
  skill: 15016,
  auth: 15017,
  schedule: 15018,
  planning: 15019,
  emotion: 15020,
} as const;

function buildWebSocketUrls() {
  if (isDev) {
    return {
      OPENAI: `${wsProtocol}//${hostname}:${devWsPorts.openai}`,
      MONITORING: `${wsProtocol}//${hostname}:${devWsPorts.monitoring}`,
      SCHEDULER: `${wsProtocol}//${hostname}:${devWsPorts.schedule}`,
      STATUS: `${wsProtocol}//${hostname}:${devWsPorts.status}`,
      PLANNING: `${wsProtocol}//${hostname}:${devWsPorts.planning}`,
      EMOTION: `${wsProtocol}//${hostname}:${devWsPorts.emotion}`,
      SKILL: `${wsProtocol}//${hostname}:${devWsPorts.skill}`,
      AUTH: `${wsProtocol}//${hostname}:${devWsPorts.auth}`,
    };
  }
  return {
    OPENAI: `${wsProtocol}//${host}/ws/openai`,
    MONITORING: `${wsProtocol}//${host}/ws/monitoring`,
    SCHEDULER: `${wsProtocol}//${host}/ws/scheduler`,
    STATUS: `${wsProtocol}//${host}/ws/status`,
    PLANNING: `${wsProtocol}//${host}/ws/planning`,
    EMOTION: `${wsProtocol}//${host}/ws/emotion`,
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
