# Shannon Minebot スキルリファレンス

> **最終更新: 2026-03-29**
> InstantSkill 70 個 + ConstantSkill 15 個

---

## InstantSkill (70 個)

即時実行スキル。LLM の function calling ツールとして公開される。
ソース: `backend/src/services/minebot/instantSkills/`

### 情報取得 (23 個)

| スキル | 主要パラメータ | 用途 |
|--------|---------------|------|
| `get-bot-status` | なし | HP, 食料, 位置, インベントリ等まとめて取得 |
| `get-position` | なし | 現在座標 |
| `get-health` | なし | 体力・空腹度 |
| `get-time-and-weather` | なし | 時刻・天候 |
| `get-equipment` | なし | 装備一覧 |
| `get-advancements` | なし | 進捗一覧 |
| `list-inventory-items` | なし | インベントリ全アイテム |
| `check-inventory-item` | itemName | 特定アイテムの所持数 |
| `list-nearby-entities` | maxDistance, maxCount | 周囲エンティティ一覧 |
| `find-nearest-entity` | entityType, maxDistance | 最寄りエンティティ検索 |
| `find-blocks` | blockName, maxDistance, count | 周囲ブロック検索 |
| `find-structure` | structureType | 構造物検索 |
| `get-block-at` | x, y, z | 指定座標のブロック情報 |
| `get-block-in-sight` | maxDistance | 視線先のブロック座標 |
| `get-blocks-in-area` | x1,y1,z1, x2,y2,z2 | 範囲内ブロック (レイヤー/統計形式) |
| `is-block-loaded` | x, y, z | チャンクロード確認 |
| `can-dig-block` | x, y, z | 掘削可能性確認 |
| `check-path-to` | x, y, z | パス到達可能性確認 |
| `check-recipe` | itemName | クラフトレシピ・必要材料 |
| `check-container` | x, y, z | コンテナ内容確認 |
| `check-furnace` | x, y, z | かまど状態確認 |
| `investigate-terrain` | context, searchRadius | LLM 駆動の地形調査 |
| `get-entity-look-direction` | entityName | エンティティの位置・視線方向 |

### 移動 (7 個)

| スキル | 主要パラメータ | 用途 |
|--------|---------------|------|
| `move-to` | x, y, z, range | 指定座標に移動 |
| `follow-entity` | targetName, range, duration | エンティティ追従 |
| `flee-from` | target, minDistance, timeout | 逃走 |
| `jump` | なし | ジャンプ |
| `stop-movement` | なし | 移動・追従・逃走を停止 |
| `look-at` | x, y, z | 指定座標を見る |
| `enter-portal` | x, y, z | ポータルに入る |

### 採掘・建築 (4 個)

| スキル | 主要パラメータ | 用途 |
|--------|---------------|------|
| `dig-block-at` | x, y, z | 指定座標のブロック掘削 |
| `mine-block` | blockName, count, searchRadius | 種類指定で近くから採掘 |
| `stair-mine` | targetY, direction, placeBlock | 階段掘り (上昇/下降) |
| `fill-area` | x1,y1,z1, x2,y2,z2 | 範囲をブロックで埋める |

### 戦闘 (5 個)

| スキル | 主要パラメータ | 用途 |
|--------|---------------|------|
| `attack-nearest` | maxDistance | 最寄り敵に単発攻撃 |
| `attack-continuously` | maxAttacks, maxDistance | 敵を倒すまで連続攻撃 |
| `combat` | target, timeout | 追いかけながら倒すまで攻撃 |
| `swing-arm` | なし | 腕を振る |
| `shoot-bow` | targetName, count, chargeSeconds | 弓/クロスボウで射撃 |

### クラフト・精錬・エンチャント (7 個)

| スキル | 主要パラメータ | 用途 |
|--------|---------------|------|
| `craft-one` | itemName | 1 個クラフト (3x3 時は作業台自動探索) |
| `start-smelting` | x,y,z, inputItem, fuelItem, count | かまどで精錬開始 |
| `check-furnace` | x, y, z | かまど状態確認 |
| `withdraw-from-furnace` | x,y,z, slot | かまどからアイテム取出 |
| `enchant-item` | x,y,z, slot | エンチャントテーブルで付与 |
| `repair-item` | x,y,z, targetItem, materialItem | 金床で修理・合成 |
| `use-stonecutter` | x,y,z, inputItem, outputItem, count | 石切台で加工 |

### コンテナ (3 個)

| スキル | 主要パラメータ | 用途 |
|--------|---------------|------|
| `check-container` | x, y, z | コンテナ内容確認 |
| `deposit-to-container` | x,y,z, itemName, count | チェストに収納 |
| `withdraw-from-container` | x,y,z, itemName, count | チェストから取出 |

### 農業・動物 (4 個)

| スキル | 主要パラメータ | 用途 |
|--------|---------------|------|
| `plant-crop` | x, y, z, cropName | 作物を植える |
| `harvest-crop` | x, y, z | 作物を収穫 |
| `use-bone-meal` | x, y, z | 骨粉使用 |
| `breed-animal` | animalType, foodItem | 動物を繁殖 |

### インタラクション (7 個)

| スキル | 主要パラメータ | 用途 |
|--------|---------------|------|
| `place-block-at` | blockName, x, y, z | ブロック設置 (自位置退避あり) |
| `activate-block` | x, y, z | ブロック右クリック |
| `use-item` | なし | 手持ちアイテム使用 |
| `use-item-on-block` | x, y, z | ブロックにアイテム使用 |
| `sleep-in-bed` | x, y, z | ベッドで寝る |
| `trade-with-villager` | tradeIndex, times | 村人と取引 |
| `fish` | count | 釣り (水面自動検出) |

### ポーション (1 個)

| スキル | 主要パラメータ | 用途 |
|--------|---------------|------|
| `brew-potion` | x,y,z, ingredient | 醸造台でポーション醸造 |

### ユーティリティ (9 個)

| スキル | 主要パラメータ | 用途 |
|--------|---------------|------|
| `chat` | message | チャット送信 |
| `drop-item` | itemName, count | アイテムドロップ |
| `equip-item` | itemName, destination | アイテム装備 (hand/head/torso/legs/feet) |
| `pickup-nearest-item` | itemName, maxDistance | 最寄りアイテム拾得 |
| `set-sneak` | enabled | スニーク ON/OFF |
| `set-sprint` | enabled | スプリント ON/OFF |
| `set-shield` | enabled | 盾ガード ON/OFF |
| `wait-time` | milliseconds | 指定時間待機 |
| `switch-constant-skill` | switchAuto* | ConstantSkill の有効/無効切替 |

### 特殊トグル (2 個)

| スキル | 主要パラメータ | 用途 |
|--------|---------------|------|
| `switch-auto-detect-block-or-entity` | enable, blockName, entityName | 自動ブロック/エンティティ検知の設定 |
| `switch-auto-shoot-arrow-to-block` | enable, blockName | 自動射撃対象ブロックの設定 |

---

## ConstantSkill (15 個)

バックグラウンド常駐スキル。優先度キューで定期実行。
ソース: `backend/src/services/minebot/constantSkills/`

| スキル | 間隔 | Critical | 用途 |
|--------|------|----------|------|
| `autoEat` | 1000ms | - | 食料自動消費 (food<18 or health<18) |
| `autoRunFromHostiles` | 1000ms | - | 敵モブから自動逃走 |
| `autoSwim` | 100ms | Yes | 溺死防止 |
| `autoAvoidDragonBreath` | 100ms | Yes | ドラゴンブレス回避 |
| `autoAvoidProjectileRange` | 1000ms | - | 飛翔体回避 |
| `autoPickUpItem` | 1000ms | - | 近くのアイテム自動拾得 |
| `autoFollow` | 1000ms | - | プレイヤー追従 |
| `autoFaceSpeaker` | 1000ms | - | 話者の方を向く |
| `autoFaceNearestEntity` | 1000ms | - | 最寄りエンティティに向く |
| `autoFaceMovedEntity` | 1000ms | - | 移動したエンティティに向く |
| `autoFaceUpdatedBlock` | 1000ms | - | 更新されたブロックに向く |
| `autoDetectBlockOrEntity` | 5000ms | - | 環境変化検知 |
| `autoUpdateState` | 5000ms | - | ボット状態更新 |
| `autoUpdateLookingAt` | 1000ms | - | 視線先更新 |
| `autoSleep` | 5000ms | - | 夜間自動就寝 |

**Critical**: `true` のスキルは InstantSkill 実行中も動作する（溺死やドラゴンブレスは即命に関わるため）。

---

## スキル追加ガイド

```typescript
// backend/src/services/minebot/instantSkills/yourSkill.ts
export default class YourSkill extends InstantSkill {
  skillName = 'your-skill'
  description = 'スキルの説明'
  params: SkillParam[] = [
    { name: 'param1', type: 'string', description: '説明', required: true },
  ]

  async runImpl(param1: string): Promise<SkillResult> {
    // 実装
    return { success: true, result: '結果メッセージ' }
  }
}
```

エラーハンドリングレベル:
- **レベル 1**: try-catch のみ
- **レベル 2**: 事前チェック (パラメータ・距離・条件)
- **レベル 3**: 詳細なエラーメッセージ (原因・対処法)
