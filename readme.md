# シャノン(SHANNON)

## 概要

教師あり経験的世話焼きアルゴリズム（Supervised Heuristic Algorithm for Navigation aNd Oblige Neighbors）シャノンは、OpenAI API を用いて実現される、Discord, Minecraft, Twitter, YouTube などのプラットフォームでユーザーと会話したり一緒に遊んだり問題解決を手伝う愛すべき AI フレンドです。

## 使い方

### インストール方法

1. リポジトリをクローンします。
2. リポジトリのルートディレクトリに移動します。
3. `pip install -r requirements.txt` を実行して必要なライブラリをインストールします。
4. `.env` ファイルを作成して、必要な API キーを設定します。

### 実行方法

1. `python3 runShannon.py` を実行して、Shannon を起動します。

## ライセンスなど

### ライセンス

このプロジェクトは MIT ライセンスの下で公開されています。詳細については、[LICENSE](LICENSE)ファイルを参照してください。

### 作者

- 名前: R41R41
- GitHub: https://github.com/R41R41
- X(Twitter): https://x.com/R4iR4i000

## その他

### ファイル構成

```
.
├── .env
├── .gitignore
├── .python-version
├── package-lock.json
├── package.json
├── readme.md
├── requirements.txt
├── runShannon.py
├── saves
└── shannon
   ├── discord_agent
   │   └── discord_agent.py
   ├── discord_bot.py
   ├── minecraft_agent
   │   └── minecraft_agent.py
   ├── minecraft_bot.py
   ├── minecraft_bot_agent
   │   ├── minecraft_bot.js
   │   └── minecraft_bot_agent.py
   ├── minecraft_server.py
   ├── prompts
   ├── shannon.py
   ├── shannon_agent
   │   ├── chat.py
   │   ├── control_bot.py
   │   ├── control_vm_and_mc.py
   │   ├── llm.py
   │   ├── memory.py
   │   ├── post_about_today.py
   │   ├── post_fortune.py
   │   ├── post_weather.py
   │   └── shannon_agent.py
   ├── tools
   │   ├── default
   │   ├── discord
   │   └── minecraft
   ├── twitter_agent
   │   └── twitter_agent.py
   ├── twitter_bot.py
   ├── utils
   │   ├── file_utils.py
   │   ├── json_utils.py
   │   └── request_utils.py
   ├── youtube_agent
   │   └── youtube_agent.py
   └── youtube_bot.py
```
