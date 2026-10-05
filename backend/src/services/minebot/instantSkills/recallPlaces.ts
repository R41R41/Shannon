import { CustomBot, InstantSkill } from '../types.js';

const AGO = (ms: number) => ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))}秒前` : `${Math.round(ms / 60_000)}分前`;

/**
 * 原子的スキル: 以前に見た場所を思い出す。
 * What the body noted as it went (water, lava, ore showing in a cave wall, a furnace it placed, a village,
 * where it died) stays known after it is out of sight. find-blocks sees only what is loaded now.
 */
class RecallPlaces extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'recall-places';
    this.description = '以前に見た場所を、今は見えていない遠くのものも含めて近い順に返します（水・溶岩・洞窟の壁に見えていた鉱石・置いた作業台やかまど・チェスト・ベッド・村・ポータル・死んだ地点）。'
      + 'まだ一度も視界に入っていない方角と、そこまでの距離も返します（村や新しい地形を探しに行く向きを決める時に）。'
      + '観測の rememberedPlaces には種類ごとの最寄り1件だけが出ます。同じ種類の別の場所や、遠い場所を知りたい時に使います。find-blocks は今読み込まれている範囲しか探せません。';
    this.params = [
      { name: 'kind', type: 'string', description: '種類（例: water, lava, diamond_ore, furnace, village, death）。一部でも可（ore で全鉱石）。省略で全種類', required: false },
      { name: 'limit', type: 'number', description: '件数（デフォルト8、最大20）', required: false, default: 8 },
    ];
  }

  async runImpl(kind?: string, limit: number = 8) {
    const memory = (this.bot as any).placeMemory;
    if (!memory) return { success: false, result: '場所の記憶がありません', failureType: 'not_ready', recoverable: false };
    const places = memory.recall(kind?.trim() || undefined, Math.max(1, Math.min(20, Math.round(Number(limit) || 8))));
    let unseen = '';
    try { unseen = `\nまだ見ていない方角（そこから先は一度も視界に入っていない）: ${memory.unseen()}`; } catch { unseen = ''; }
    if (!places.length) {
      return { success: true, result: `${kind ? `「${kind}」の` : ''}覚えている場所はまだありません（見たことがある場所だけを覚えています）。新しい地点へ移動すると増えます${unseen}` };
    }
    const now = Date.now();
    const lines = places.map((place: any) => `${place.kind}: (${place.position.x}, ${place.position.y}, ${place.position.z}) ${place.distance}m ${place.direction}`
      + (place.count > 1 ? ` ×${place.count}` : '') + ` 最後に見たのは${AGO(now - place.lastSeenAt)}` + (place.note ? `（${place.note}）` : ''));
    return { success: true, result: `覚えている場所（近い順）:\n${lines.join('\n')}\n※ 離れている間に変わっていることがあります（着いたら確かめる）${unseen}` };
  }
}

export default RecallPlaces;
