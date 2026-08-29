/**
 * ワールド知識の永続化・検索サービス。
 * スキル結果から構造化データを抽出して MongoDB に保存し、
 * LLM のコンテキストに注入するための検索機能を提供する。
 */
import {
  WorldBlock,
  WorldStructure,
  WorldContainer,
  WorldZone,
  WorldDanger,
  BotSnapshot,
} from '../../../models/WorldKnowledge.js';
import { isAssignedMinecraftServerId } from '../../../modules/memory/minecraftIdentity.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:WorldKnowledge');

interface Position { x: number; y: number; z: number }

export class WorldKnowledgeService {
  private static instances = new Map<string, WorldKnowledgeService>();
  private serverName: string;

  private constructor(serverName: string) {
    this.serverName = serverName;
  }

  /** Minecraft world knowledge is per server. 'default' is not an identity. */
  static forServer(serverId: string | undefined): WorldKnowledgeService | null {
    if (!isAssignedMinecraftServerId(serverId)) return null;
    let service = this.instances.get(serverId);
    if (!service) {
      service = new WorldKnowledgeService(serverId);
      this.instances.set(serverId, service);
    }
    return service;
  }

  private toGeo(pos: Position) {
    return { type: 'Point' as const, coordinates: [pos.x, pos.z] as [number, number] };
  }

  // ─── Blocks ───

  async recordBlocks(blockName: string, positions: Position[], quantity = 1): Promise<void> {
    const ops = positions.map((pos) => ({
      updateOne: {
        filter: { serverName: this.serverName, blockName, 'position.x': pos.x, 'position.y': pos.y, 'position.z': pos.z },
        update: {
          $set: { lastVerifiedAt: new Date(), quantity, geo: this.toGeo(pos) },
          $setOnInsert: { discoveredAt: new Date(), serverName: this.serverName, blockName, position: pos },
        },
        upsert: true,
      },
    }));
    try {
      await WorldBlock.bulkWrite(ops);
      log.debug(`ブロック記録: ${blockName} x${positions.length}`);
    } catch (err) {
      log.debug(`ブロック記録スキップ: ${err}`);
    }
  }

  async findNearbyBlocks(center: Position, radiusBlocks: number, blockName?: string): Promise<Array<{ blockName: string; position: Position; lastVerifiedAt: Date }>> {
    const query: any = {
      serverName: this.serverName,
      geo: { $nearSphere: { $geometry: this.toGeo(center), $maxDistance: radiusBlocks } },
    };
    if (blockName) query.blockName = blockName;
    try {
      return await WorldBlock.find(query).sort({ lastVerifiedAt: -1 }).limit(20).lean();
    } catch { return []; }
  }

  // ─── Structures ───

  async recordStructure(structureType: string, position: Position, characteristicBlocks: string[] = []): Promise<void> {
    try {
      await WorldStructure.findOneAndUpdate(
        { serverName: this.serverName, structureType, 'position.x': { $gte: position.x - 50, $lte: position.x + 50 }, 'position.z': { $gte: position.z - 50, $lte: position.z + 50 } },
        { $set: { position, geo: this.toGeo(position), characteristicBlocks }, $setOnInsert: { discoveredAt: new Date(), serverName: this.serverName, structureType } },
        { upsert: true },
      );
      log.info(`構造物記録: ${structureType} at (${position.x}, ${position.y}, ${position.z})`, 'green');
    } catch (err) {
      log.debug(`構造物記録スキップ: ${err}`);
    }
  }

  async findStructures(structureType?: string): Promise<Array<{ structureType: string; position: Position; discoveredAt: Date }>> {
    const query: any = { serverName: this.serverName };
    if (structureType) query.structureType = structureType;
    try { return await WorldStructure.find(query).sort({ discoveredAt: -1 }).limit(10).lean(); }
    catch { return []; }
  }

  // ─── Containers ───

  async recordContainer(containerType: string, position: Position, contents: Array<{ name: string; count: number }>): Promise<void> {
    try {
      await WorldContainer.findOneAndUpdate(
        { serverName: this.serverName, 'position.x': position.x, 'position.y': position.y, 'position.z': position.z },
        { $set: { containerType, contents, lastCheckedAt: new Date(), geo: this.toGeo(position) }, $inc: { accessCount: 1 }, $setOnInsert: { serverName: this.serverName, position } },
        { upsert: true },
      );
      log.debug(`コンテナ記録: ${containerType} at (${position.x}, ${position.y}, ${position.z})`);
    } catch (err) {
      log.debug(`コンテナ記録スキップ: ${err}`);
    }
  }

  async findNearbyContainers(center: Position, radiusBlocks: number): Promise<Array<{ containerType: string; position: Position; contents: Array<{ name: string; count: number }>; lastCheckedAt: Date }>> {
    try {
      return await WorldContainer.find({
        serverName: this.serverName,
        geo: { $nearSphere: { $geometry: this.toGeo(center), $maxDistance: radiusBlocks } },
      }).sort({ lastCheckedAt: -1 }).limit(10).lean();
    } catch { return []; }
  }

  // ─── Zones ───

  async recordZone(biome: string, position: Position): Promise<void> {
    try {
      await WorldZone.findOneAndUpdate(
        { serverName: this.serverName, biome, 'position.x': { $gte: position.x - 32, $lte: position.x + 32 }, 'position.z': { $gte: position.z - 32, $lte: position.z + 32 } },
        { $set: { position, geo: this.toGeo(position) }, $setOnInsert: { discoveredAt: new Date(), serverName: this.serverName, biome } },
        { upsert: true },
      );
    } catch {}
  }

  // ─── Dangers ───

  async recordDanger(dangerType: string, position: Position, severity: number, description = ''): Promise<void> {
    try {
      await WorldDanger.findOneAndUpdate(
        { serverName: this.serverName, dangerType, 'position.x': { $gte: position.x - 10, $lte: position.x + 10 }, 'position.z': { $gte: position.z - 10, $lte: position.z + 10 } },
        { $set: { position, geo: this.toGeo(position), severity, description, lastSeenAt: new Date() }, $setOnInsert: { discoveredAt: new Date(), serverName: this.serverName, dangerType } },
        { upsert: true },
      );
    } catch {}
  }

  async findNearbyDangers(center: Position, radiusBlocks: number): Promise<Array<{ dangerType: string; position: Position; severity: number; description: string }>> {
    try {
      return await WorldDanger.find({
        serverName: this.serverName,
        geo: { $nearSphere: { $geometry: this.toGeo(center), $maxDistance: radiusBlocks } },
      }).sort({ severity: -1 }).limit(10).lean();
    } catch { return []; }
  }

  // ─── Bot Snapshots ───

  async recordSnapshot(data: {
    position: Position;
    health: number;
    food: number;
    dimension: string;
    biome: string;
    inventory: Array<{ name: string; count: number; durabilityRemaining?: number; durabilityMax?: number }>;
  }): Promise<void> {
    try {
      await BotSnapshot.create({ serverName: this.serverName, ...data });
    } catch {}
  }

  // ─── Context Builder (for LLM injection) ───

  async buildContextForPosition(center: Position, radiusBlocks = 64): Promise<string> {
    const [blocks, containers, dangers, structures] = await Promise.all([
      this.findNearbyBlocks(center, radiusBlocks),
      this.findNearbyContainers(center, radiusBlocks),
      this.findNearbyDangers(center, radiusBlocks),
      this.findStructures(),
    ]);

    const lines: string[] = [];

    if (blocks.length > 0) {
      const grouped = new Map<string, number>();
      for (const b of blocks) grouped.set(b.blockName, (grouped.get(b.blockName) || 0) + 1);
      const blockSummary = Array.from(grouped.entries()).map(([name, count]) => `${name} x${count}`).join(', ');
      lines.push(`[既知のブロック] ${blockSummary}`);
    }

    if (containers.length > 0) {
      for (const c of containers) {
        const itemList = c.contents.slice(0, 5).map(i => `${i.name}x${i.count}`).join(', ');
        const age = Math.round((Date.now() - new Date(c.lastCheckedAt).getTime()) / 60000);
        lines.push(`[チェスト] (${c.position.x}, ${c.position.y}, ${c.position.z}) ${itemList} (${age}分前)`);
      }
    }

    if (dangers.length > 0) {
      for (const d of dangers) {
        lines.push(`[危険] ${d.dangerType} at (${d.position.x}, ${d.position.y}, ${d.position.z}) 危険度:${d.severity}/10`);
      }
    }

    if (structures.length > 0) {
      for (const s of structures) {
        lines.push(`[構造物] ${s.structureType} at (${s.position.x}, ${s.position.y}, ${s.position.z})`);
      }
    }

    return lines.length > 0 ? `\n=== ワールド知識 ===\n${lines.join('\n')}\n` : '';
  }

  // ─── Stats ───

  async getStats(): Promise<Record<string, number>> {
    const [blocks, structures, containers, zones, dangers] = await Promise.all([
      WorldBlock.countDocuments({ serverName: this.serverName }),
      WorldStructure.countDocuments({ serverName: this.serverName }),
      WorldContainer.countDocuments({ serverName: this.serverName }),
      WorldZone.countDocuments({ serverName: this.serverName }),
      WorldDanger.countDocuments({ serverName: this.serverName }),
    ]);
    return { blocks, structures, containers, zones, dangers };
  }
}
