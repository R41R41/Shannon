import type { KnowledgeItem } from './knowledge.js';

type Seed = Pick<KnowledgeItem, 'id' | 'kind' | 'situation' | 'advice' | 'conditions'>;

/**
 * Strategy knowledge that used to be hardcoded in the campaign prompt and the
 * emergency instructions. It now enters the learned store as human-sourced
 * priors at 50% confidence, so the agent's own experience can confirm,
 * refine or retire it like any other lesson.
 */
export const HUMAN_SEED_KNOWLEDGE: Seed[] = [
  // Rewritten 2026-10-05: offered as two equal choices, "wait for morning" took 11-22 minutes of 60-75 minute runs
  // (paid runs L96, L98-L100: five or six 110-second waits a night), while the run that reached the Nether fastest
  // went on mining underground through the night (L94, 39 minutes).
  { id: 'seed-night-surface', kind: 'prefer', situation: '夕暮れ・夜の地上',
    advice: '夜の地上は敵が湧きやすい。地上をさまよわず、地下へ入って採掘を続ける（鉄・ダイヤ・黒曜石の材料など、次に要る物を深い所で掘る。地下の作業は夜も昼も変わらない）。'
      + '縦穴（dig-shelter）に入って朝まで待つのは、体力が半分以下・食べる物が無い・つるはしが無い時だけにする（待つと夜1回で約9分が過ぎ、その間は何も進まない）。'
      + 'ベッドで寝て夜を飛ばせるのは暗くなってから（夕暮れのうちは寝られない）',
    conditions: { timeBands: ['dusk', 'night'], depthBands: ['surface', 'high'] } },
  { id: 'seed-preparation-minimal', kind: 'prefer', situation: '食料・燃料などを準備する時',
    advice: '準備は当面を満たす最小量にし、長期目標の道具・資源の連鎖を止めない。生の食料も食べられる', conditions: {} },
  { id: 'seed-food-not-yet', kind: 'avoid', situation: '空腹度に余裕がある時',
    advice: '空腹度が高く、食べられる物も手持ちにあるうちは、食料集めを始めず、道具・資源の連鎖を先に進める（手持ちの食料がほとんど無いなら、この限りではない）', conditions: { minFood: 14 } },
  // Three paid runs in a row (L88b, L94, L95, 2026-10-05) went underground or into the Nether with little or no
  // food, could not heal, and died of the hits that followed; the line above had kept them from gathering any.
  { id: 'seed-food-stock-before-depth', kind: 'prefer', situation: '鉄のつるはしができて地下深くへ潜る時、ネザーへ行く準備をする時',
    advice: '体力は満腹度18以上の時しか自然に回復しない。洞窟の奥やネザーでは戦うたびに体力が減ったまま戻らず、少しの被弾で倒れる。'
      + '深く潜る前、ポータルに入る前に、焼いた肉などを十数個持ち、満腹度を高く保つ（牛・豚・羊・鶏を狩って、かまどで焼く。燃料は石炭か木）。'
      + '手持ちが数個まで減ったら、先へ進む前に補う',
    conditions: { carryingAny: ['iron_pickaxe', 'diamond_pickaxe', 'flint_and_steel', 'obsidian'] } },
  { id: 'seed-no-fish-chasing', kind: 'avoid', situation: '水中の魚を食料にしようとする時',
    advice: '素手で水中の魚を追うのは時間がかかり、溺れる危険もある。食料は陸の動物や作物から得る',
    conditions: { tools: ['attack-continuously', 'attack-nearest'] } },
  { id: 'seed-emergency-shelter', kind: 'prefer', situation: '緊急時、夜で敵が多く逃げ切れない時',
    advice: '乾いた地面でdig-shelterを使い、縦穴に入って頭上を塞ぐ',
    conditions: { emergency: true, timeBands: ['dusk', 'night'] } },
  { id: 'seed-emergency-no-water', kind: 'avoid', situation: '敵から逃げる時',
    advice: '水辺へ逃げない。水中では動きが遅く、溺れる危険もある', conditions: { emergency: true, threatsPresent: true } },
  { id: 'seed-shelter-stay-sealed', kind: 'avoid', situation: 'dig-shelterで塞いだ縦穴の中で、近くに敵がいる時',
    advice: '頭上や壁を掘って出ない。list-nearby-entitiesで敵がいないことを確かめてから出る',
    conditions: { threatsPresent: true, tools: ['dig-shelter', 'dig-block-at'] } },
  // Taught by the user on 2026-10-01: whether the night can be got through decides a run.
  { id: 'seed-bed-from-sheep', kind: 'prefer', situation: '昼の地上で、羊が近くにいて、まだベッドを持っていない時',
    // 2026-10-05 the user again: sheep near the spawn first, for a bed, and their meat. Nights sat out took 11-22
    // minutes of a run, and no village (the other source of a bed) was ever in sight that day.
    advice: '夜を越せるかどうかが重要。羊が近くにいるなら、先に3頭狩って同じ色の羊毛3個を集め、板材3枚と作業台でベッドを作っておく（羊を倒すと羊毛1個と羊肉が手に入るので、肉も拾ってかまどで焼く）。'
      + '夜は暗くなってからsleep-in-bedで寝ると朝まで飛ばせるので、待機や避難穴より時間を失わない（待てば夜1回で約9分）。朝になったらベッドを回収して持ち歩く（設備として守られているので dig-block-at に takeEquipment: true）',
    conditions: { dimensions: ['overworld'], timeBands: ['day', 'dawn'], othersAny: ['sheep'], carryingNone: ['*_bed'] } },
  { id: 'seed-village-in-sight', kind: 'prefer', situation: '昼の地上で、村が見える範囲にある時',
    advice: '村が近くにあるなら寄る。村にはベッドがあって夜に寝られ、作物や干し草などの食料も手に入る。観測のlandmarksに村の方角と距離が出る',
    conditions: { dimensions: ['overworld'], landmarksAny: ['village'] } },
  // Taught by the user on 2026-10-02: wood and food on the surface first, and a look for a village along the way.
  { id: 'seed-survey-surface-early', kind: 'prefer', situation: '序盤の昼の地上で、木や食料を集めている時',
    advice: '序盤はまず地上で木と食料を確保する。そのついでに、同じ方角へ歩いて地表を見て回る（数分まで）。村が見つかれば、ベッドで夜を飛ばせて、食料や取引も手に入る（村は観測のlandmarksに方角と距離が出る）。'
      + 'まだ見ていない方角は recall-places で分かる。見つからなければ切り上げて、道具と資源の連鎖へ戻る',
    conditions: { dimensions: ['overworld'], timeBands: ['day', 'dawn'], depthBands: ['surface', 'high'] } },
  // From paid run L82 (2026-10-02): diamond pickaxe, bucket and full iron armour by forty minutes, and nothing
  // to eat: at food 0 and health 4, at dusk, it went looking for sheep with zombies about. The user's own
  // order of things is wood and food first.
  { id: 'seed-food-before-empty', kind: 'prefer', situation: '空腹度が半分を切り、食料を持っていない時',
    advice: '食料を持たずに空腹度が半分を切ったら、道具や採掘より先に食料を確保する。空腹度が0になると体力が自然回復しなくなり、走れず、体力も削られる。'
      + '昼の地上で動物を狩るのがいちばん早い（夜は地上へ出にくいので、昼のうちに数回分を持っておく）',
    conditions: { maxFood: 10 } },
  // From the runs of 2026-10-02: a body sealed in its shelter waited seven minutes for morning, three or four
  // waits in a row, because the next thing on its list was on the surface (L77, L80, L81). A night is seven of
  // every twenty minutes.
  { id: 'seed-night-work-underground', kind: 'prefer', situation: '夜、塞いだ縦穴や地下にいて、朝を待とうとしている時',
    advice: '朝を待って何もしない時間を作らない。夜の間は、地下でできる用事（採掘・精錬・クラフト。塞いだ縦穴からは横や下へ掘り進める）を先に進め、'
      + '地上でしかできない用事（食料・木）は朝に回す。待つのは、地下でできる用事が何も無い時だけ',
    conditions: { dimensions: ['overworld'], timeBands: ['dusk', 'night'], tools: ['wait-time'] } },
  // From the Nether attempts of 2026-10-02 (L77b to L77g): a body that went through the portal the moment it was
  // lit, with a stone sword and an iron chestplate, was shot from the air by ghasts and from the ground by
  // skeletons, and never got within forty blocks of the fortress.
  { id: 'seed-nether-prepare', kind: 'prefer', situation: 'ネザーポータルを作る・入る前',
    advice: 'ネザーに入る前に装備を整える。ネザーでは遠くから撃ってくる相手（ガストは60ブロック先から、スケルトン、ブレイズ）が多く、水は置けず、溶岩に触れると火を消せない。'
      + '入る前に用意するもの: 鉄の防具一式、盾（木の板6と鉄1）、鉄の剣、食料を十数個、設置用の丸石を2スタック以上（ネザーラックは火の玉で壊れるが丸石は壊れない）、丸石のハーフブロック12個（作業台に丸石3個を横一列で6個できる。ブレイズのスポナーの隣で身を囲う build-around-self の slit_cage に8個要る）、作業台、予備のつるはし。弓矢があれば遠くの相手に届く。'
      + 'ネザーでは開けた足場に長く立たず、移動はネザーラックを掘って覆いのある道を作るか、丸石で屋根と壁を置いてから進む',
    conditions: { dimensions: ['overworld'], carryingAny: ['obsidian', 'flint_and_steel'] } },
  { id: 'seed-nether-cover', kind: 'prefer', situation: 'ネザーで移動する・作業する時',
    advice: 'ネザーでは、ガストの視線が通る開けた場所や、溶岩の上の細い足場に長く留まらない（火の玉は足場ごと壊し、身体を溶岩へ落とす）。'
      + '遠くへ行く時はネザーラックの中を掘り進む（つるはしならすぐ掘れる）か、足場に丸石の壁と屋根を付ける。撃たれたら、まず丸石か地形で視線を切る',
    conditions: { dimensions: ['the_nether'] } },
  { id: 'seed-blaze-fire-resistance', kind: 'prefer', situation: 'ネザー要塞でブレイズを倒してブレイズロッドを取る時',
    advice: 'ブレイズロッドはブレイズを倒すと落とす。ブレイズの攻撃は火なので、火炎耐性のポーション（持ち物に potion か splash_potion、contents が fire_resistance）を飲んでから挑むと効かない。'
      + '無課金の実測: 火炎耐性あり・石の剣・鉄の胸当て・盾なしでブレイズ3体と3回戦って、3回とも被ダメージ0でロッドを回収。効果は3分なので、ブレイズが見えてから use-item（itemName=potion, contents=fire_resistance）で飲む。'
      + '火炎耐性は自分では作れない（醸造にブレイズロッドが要る）。手に入れるにはピグリンと金インゴットを物々交換する（別の知識）。'
      + '持っていない時の次善は盾: 身体が自動で左手に持ち、飛んでくる火の玉に構える（実測、石の剣・鉄の胸当て・盾でブレイズ3体: 2〜3体倒せて、6回中1回死亡）。'
      + '戦う時は attack-continuously で相手の種類を指定する（離れた相手には maxDistance を40以上。指定した相手は戦っている間、居るだけでは中断されない）。'
      + '火炎耐性が無くても、スポナーの隣に囲い（build-around-self の slit_cage。別の知識）を建てれば被ダメージ0で狩れる。'
      + 'ただの囲いに穴をあけて待つだけでは倒せない（実測: 足元の穴はブレイズがこちらを見失って寄ってこない。目の高さの穴は遠くから撃ち込まれる）',
    conditions: { dimensions: ['the_nether'] } },
  { id: 'seed-blaze-slit-cage', kind: 'procedure', situation: 'ネザー要塞でブレイズのスポナーを見つけた・場所を覚えている時（ブレイズロッドを集める）',
    advice: 'スポナーの隣に囲いを建て、中から隙間ごしに殴る（無課金ラボの実測: 石の剣・鉄の胸当て・盾で、建築34秒、3分半でブレイズ10体撃破、ロッド5本、被ダメージ0。スポナーは壊さず、繰り返し使える）。'
      + '(1) 持ち物: 建築用ブロック（丸石など）約80個、ハーフブロック8個、剣。足りなければ先に揃える（要塞の nether_bricks も建築用ブロックになる。ハーフブロックは同じ石3個を作業台に横一列で6個）。'
      + 'ブレイズのスポナーの場所は、観測の「覚えている場所」に spawner … blaze と出る（出ていなければ recall-places の kind=spawner）。要塞の中を歩いてブレイズを探さない: 通路にはウィザースケルトンが何体もいる。'
      + '(2) accept-threat（kinds="blaze,wither_skeleton"、seconds=120）を呼んでから、スポナーの東西南北どれかの隣のマス（足がスポナーと同じ高さ）へ move-to する。呼ばないと、ブレイズやウィザースケルトンが見えるたびに緊急対応が移動を止め、近づいては逃げるのを繰り返す。'
      + '途中でウィザースケルトンが寄ってきたら、走り抜けずに立ち止まって holdPosition で倒してから進む（走り抜けると殴られ続ける。別の知識）。着いたらすぐ建てる（囲いの中は高さ2なのでウィザースケルトンは入れず、目も合わないので殴られない）。'
      + '(3) 着いたらすぐ build-around-self（structureName=slit_cage）。最初の十数個で四方と頭上が塞がる。先に戦わない（スポナーの横で開けたまま戦うと、鉄の装備と盾でも43秒で倒された）。途中で止まったら、もう一度呼べば続きから建てる。'
      + '(4) 中から attack-continuously（entityName=blaze、holdPosition=true）を繰り返し呼ぶ。通路に湧いたブレイズだけを隙間ごしに殴る。相手からは身体の目が見えないので撃たれない。「手の届く所に来ませんでした」は、まだ通路に湧いていないだけなので、もう一度呼ぶ（スポナーの周りの開けた所に湧いたブレイズは通路に来ない。追って外へ出ない）。'
      + '(5) 落とし物は通路に落ち、5分で消える。3分ほど戦ったら、accept-threat（kinds="blaze,wither_skeleton"、seconds=120）を呼び直してから（観測の acceptedThreats の残りが切れると、拾う途中で寄ってきたブレイズに緊急対応が掛かり、開けた壁から外へ出て戦うことになる）、pickup-nearest-item（blaze_rod）を、見つからなくなるまで繰り返す（壁を掘って通路へ出る）。'
      + '終わったらすぐ中央のマスへ move-to で戻り、build-around-self をもう一度呼んで壁を直す（観測の builtAround に欠けたマスの数が出る。0になれば元どおり）。'
      + 'エンドポータルにはエンダーアイが最大12個要り、ブレイズロッド1本でパウダー2個なので、探す分も入れて7本以上になるまで (4)(5) を繰り返す',
    conditions: { dimensions: ['the_nether'] } },
  { id: 'seed-piglin-barter', kind: 'prefer', situation: 'ネザーで、火炎耐性のポーションやエンダーパールが要る時',
    advice: 'ピグリン（piglin。ゾンビピグリンではない）に金インゴットを渡すと、約6秒後に何かを投げ返す（物々交換）。use-item-on-entity（itemName=gold_ingot, entityName=piglin, count=回数）で渡して拾うところまで行う。'
      + '返ってくる物は確率: 火炎耐性のポーション（飲む用と投げる用を合わせて約30回に1回）、エンダーパール（約50回に1回、2〜4個）、黒曜石、火打ち石の材料など。無課金の実測では10回で、エンダーパール4個とポーション1本が出た。'
      + '金は nether_gold_ore をつるはしで掘ると金塊（gold_nugget）が2〜6個出る。金塊9個で金インゴット1個（作業台）。'
      + 'ピグリンは金の防具を1つも着けていない相手を襲う。先に金インゴット4個で金のブーツ（golden_boots）を作って履く（足が空いていれば身体が自動で着ける。鉄のブーツを履いているなら equip-item で履き替える）。'
      + 'ピグリンの近くで金鉱石やチェストを壊すと怒るので、離れた所で掘る',
    conditions: { dimensions: ['the_nether'] } },
  { id: 'seed-wither-skeleton-height', kind: 'prefer', situation: 'ネザー要塞でウィザースケルトンが近づいてくる・通り道にいる時',
    advice: 'ウィザースケルトンは殴るだけで撃ってこない。背が高い（約2.4ブロック）。走って横を抜けようとしない（無課金の実測: 鉄の防具一式で3体の脇を走り抜けると15回殴られ、衰弱のダメージで死んだ）。'
      + 'まだ隣に来ていないうちに build-around-self（structureName=slit_shelter、約2秒）で1マスの囲いに入り、中から attack-continuously（entityName=wither_skeleton、holdPosition=true）を繰り返す。'
      + '寄ってきた相手を隙間ごしに一方的に倒せる（無課金の実測: 3体と2回戦い、2回とも全滅させて被弾0）。'
      + 'もう隣にいる時は囲いが間に合わないので、その場に立ち止まって同じ攻撃で迎え撃つ（鉄の剣・鉄の防具一式・盾で3体と3回、3回とも全滅させて被ダメージ0〜8.5。盾は殴る合間に身体が自動で構える）。その場から殴る攻撃は緊急対応中でも断られない。'
      + '殴られると「衰弱」が付き、離れても10秒ほど体力が減り続けるので、体力が半分を切ったら囲いの中で回復を待つ',
    conditions: { dimensions: ['the_nether'] } },
  { id: 'seed-slit-shelter', kind: 'prefer', situation: '敵が向かってくる・遠くから撃たれている・逃げ切れない時（建築用ブロックとハーフブロックを持っている）',
    advice: 'build-around-self（structureName=slit_shelter）は、いま立っている場所に約2秒で1マスの囲いを建てる（建築用ブロック10個とハーフブロック4個。地面を掘らないので、橋の上や掘れない場所でも使える）。'
      + '外の相手からは身体の目が見えないので狙われない（無課金の実測: ブレイズ3体の前で2回、2回とも被弾0）。隣まで来た殴る相手は、中から attack-continuously（holdPosition=true）で隙間ごしに倒せる（ウィザースケルトン3体と2回、2回とも全滅・被弾0）。'
      + '殴る相手がもう隣に立っている時は、そのマスに置けないので間に合わない。ハーフブロックは同じ石3個を作業台に横一列で6個できる。丸石が手に入ったら8個ほど作って持ち歩く',
    conditions: { threatsPresent: true } },
  { id: 'seed-shield-early', kind: 'prefer', situation: '鉄が手に入った時',
    advice: '鉄インゴットができたら、つるはしの次に盾を作る（板6＋鉄インゴット1、作業台）。持っていれば身体が自動で左手に持ち、飛んでくる矢や火の玉に自動で構える（操作は不要）。'
      + '無課金の実測: スケルトン（7〜13m先）の矢は、盾なしで13〜14発中6〜10発当たり、盾ありで14発中1〜2発。防具も、作って持てば身体が自動で着る',
    conditions: { dimensions: ['overworld'], carryingAny: ['iron_ingot', 'raw_iron'] } },
  { id: 'seed-sleep-through-night', kind: 'prefer', situation: '夕暮れ・夜に、ベッドを持っているか近くにベッドがある時',
    advice: '敵が近くにいなければsleep-in-bedで寝て夜を飛ばす。朝になったらベッドを掘って回収し、持ち歩いて次の夜も使う',
    conditions: { timeBands: ['dusk', 'night'], tools: ['sleep-in-bed', 'dig-shelter', 'wait-time'] } },
];

export function seedItems(now: string): KnowledgeItem[] {
  return HUMAN_SEED_KNOWLEDGE.map(seed => ({ ...seed, conditions: { ...seed.conditions }, source: 'human-seed',
    provenance: ['human-seed'], support: 0, contradict: 0, uses: 0, createdAt: now, updatedAt: now }));
}

/**
 * A human can teach new priors after the store exists: add the seeds it has
 * never held, and take a reworded seed where the old wording has not been
 * tested yet. An id already tested is left alone, also when experience has
 * retired or re-weighted it.
 */
export function addMissingSeeds(items: KnowledgeItem[], now: string): number {
  const known = new Map(items.map(item => [item.id, item]));
  let changed = 0;
  for (const seed of seedItems(now)) {
    const held = known.get(seed.id);
    if (!held) { items.push(seed); changed++; continue; }
    const untested = held.source === 'human-seed' && held.support + held.contradict === 0 && !held.retired;
    if (untested && (held.advice !== seed.advice || held.situation !== seed.situation || JSON.stringify(held.conditions) !== JSON.stringify(seed.conditions))) {
      Object.assign(held, { kind: seed.kind, situation: seed.situation, advice: seed.advice, conditions: seed.conditions, updatedAt: now });
      changed++;
    }
  }
  return changed;
}
