export type MinecraftServerEndpoint = "status" | "start" | "stop";

export type MinecraftServerName =
  | "1.19.0-youtube"
  | "1.21.4-test"
  | "1.21.1-play"
  | "1.21.4-fabric-youtube"
  | "1.21.11-fabric-test"
  /** Shannon's own persistent world, where the Minebot can be her companion body (docs/minebot-companion-body.md). */
  | "shannon-home";

export interface MinecraftInput {
  serverName?: MinecraftServerName | null;
  command?: MinecraftServerEndpoint | null;
}

export interface MinecraftOutput {
  serverName?: MinecraftServerName | null;
  success?: boolean | null;
  message?: string | null;
  statuses?: { serverName: MinecraftServerName; status: boolean }[] | null;
}

export type MinecraftEventType =
  | "minecraft:status"
  | "minecraft:start"
  | "minecraft:stop"
  | `minecraft:${MinecraftServerName}:status`
  | `minecraft:${MinecraftServerName}:start`
  | `minecraft:${MinecraftServerName}:stop`
  | "minecraft:action"
  | "minecraft:env_input"
  | "minecraft:get_message"
  | "minecraft:post_message";
