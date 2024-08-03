# TEST

## shannon

### tools

- [x] add_reaction_n_discord_message
- [x] bing_search
- [ ] create_new_tool
- [x] chat_on_discord
- [x] voice_chat_on_discord
- [x] generate_image
- [x] get_current_time
- [x] get_discord_server_emoji
- [x] get_recent_discord_channel_log
- [x] search_my_memmory
- [x] search_weather
- [x] solve_math_problem

### request

- [x] discord_chat
- [x] discord_voice_chat
- [x] post_weather_data
- [x] post_weather_comment
- [x] post_fortune
- [x] post_about_today

### scheduler

- [ ] ltm_delete_db

## discord

### input

- [x] voice_chat
- [x] voice_chat_in_or_out
- [ ] minecraft
- [ ] shannon
- [x] post
- [x] on_message

### request

- [x] chat
- [x] voice_chat
- [x] voice_chat_in_or_out
- [x] get_recent_channel_log
- [x] add_reaction
- [x] get_server_emoji
- [x] increase_youtube_subscriber_count

## twitter

### request

- [ ] status
- [ ] schedule_status
- [ ] schedule_start
- [ ] schedule_stop
- [x] post_fortune
- [x] post_about_today
- [x] post_weather
- [x] get_latest_video
- [x] post_latest_video

### scheduler

- [x] post_fortune
- [x] post_aboutToday
- [x] post_weather

## youtube

### request

- [ ] status
- [ ] schedule_status
- [ ] schedule_start
- [ ] schedule_stop
- [x] check_subscriber_count
- [x] get_latest_video
- [x] check_video_list
- [ ] reply_comment

### scheduler

- [x] check_video_count
- [x] check_subscriber_count
- [ ] reply_comment

## minecraft

### request

### scheduler

## minecraft_bot

### request

- [x] login_minecraft
- [x] logout_minecraft

### scheduler

## mineflayer

### constantSkill

- [x] autoAttackHostile
- [x] autoAvoidProjectile
- [x] autoEat
- [x] autoPickUpItem
- [x] autoRunFromHostile
- [x] autoAvoidProjectileRange

### instantSkill

- [x] chat
- [x] getParams
- [x] equipArmor
- [x] holdItem
- [x] attackEntity
- [x] followEntity
- [x] throwItem
- [x] getEquippedArmors
- [x] getInventoryItems
- [x] getInstantSkills
- [x] getHoldingItems
- [x] getEntitiesInfo
- [x] stopInstantSkill
- [ ] updateInstantSkill
- [ ] updateConstantSkill
- [x] displayInstantSkill
- [x] displayConstantSkill
- [x] displayInstantSkills
- [x] displayConstantSkills
- [x] displayInventory
- [x] displayBotStatus
- [x] getBotStatus
- [x] getBlocksData
- [x] findPlaceablePosition
- [x] craftItem
- [x] searchBlock
- [x] collectBlock
- [x] placeBlock
- [ ] buildStructure
- [x] getStructure
- [ ] saveStructure
- [ ] imagineStructure
- [x] eatFood
- [x] faceEntity

# TODO

## Tool の追加

トークン数削減

- 英語化
- 必要なツール群を必要なときだけ呼び出す
  - LLM
  - MinecraftLLM
  - DiscordLLM

以下はコマンドからは呼べないようにする

- [x] getEquippedArmors
- [x] getInventoryItems
- [x] getNearestEntitiesId
- [x] getEntityPosition
- [x] stopInstantSkill
- [x] getHoldingItems
- [x] getBotStatus
- [x] getBlocksData

以下のプロンプトをテスト

- [x] インベントリに武器のアイテムはある？
- [x] 指定した防具を装備するスキルを覚えて
- [x] 防具を全部脱いで
- [x] 今着ている防具の情報を教えて
- [x] 今持ってる防具を全部着て
- [x] 持っている武器を手に持って
- [x] スキルリストを表示して
- [x] インベントリのアイテムを表示して
- [x] constant の方を表示して
- [x] 持ってる砂を全部投げて
- [x] シャノン、僕についてきて
- [x] 追尾をやめて
- [x] シャノン、今手に持っているアイテムはなんですか？
- [x] シャノン、お腹空いてる？
- [x] シャノン、ご飯食べて
- [x] シャノン、近くにどんなエンティティがいるか教えて
- [x] シャノン、こっち向いて
- [x] シャノン、板材を作って僕に渡して
- [x] シャノン、鉄のツルハシを作って
- [x] シャノン、近くに砂ブロックはある？
- [x] シャノン、作業台を近くに置いて
- [x] シャノン、君の近くでブロックを置ける座標を教えて
- [x] シャノン、brown_terracotta を探して
- [x] シャノン、岩盤ブロックを探して
- [x] シャノン、砂ブロックを 10 個集めて

以下のツールを作成

- [x] learn_new_instant_skill
- [ ] learn_new_constant_skill
- [ ] edit_instant_skill
- [ ] edit_constant_skill

音声会話

- [ ] VoicePeak
- [x] 会話履歴からの適切な返答
- [x] 返答判断
- [x] ファイル保存せずに音声データをそのまま送信
  - [x] 入力
  - [x] 出力
- [x] ツールなしで実行
- [ ] ユーザーが会話していたら発話終了
- [ ] ツールの呼び出しタイミング
- [ ] まだ自分の発言中は次の発言の再生を始めない

ツールの呼び出しタイミング
・LLMAgent で返信
・別のツールが必要そうなら search tool で該当ツールを探す
・import tool で見つけたツールを読み込む
