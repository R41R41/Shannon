# UID 移行リハーサル（dev）

本番 `users` 3件はすべて `firebaseUid` 未設定。本番切替前に **dev 専用 Firebase + shannon_dev** で dry-run → apply → ログイン確認まで通す。

## 現状（2026-08-30）

| 項目 | 状態 |
|---|---|
| 移行スクリプト | `backend/scripts/user-binding-migration.mjs` 実装済み |
| Settings manifest dry-run | `POST /api/identity/validate-manifest` 実装済み |
| 隔離 fixture リハーサル | ✅ `scripts/probe-user-binding-migration.cjs --isolated-fixture` 成功（2026-08-30） |
| prod manifest | ✅ `prod-user-binding-manifest.json` 確定・validate 済（2026-08-30、Git 外） |
| dev `shannon_dev.users` | ✅ 3件 seed + **UID 绑定 apply 済**（2026-08-30） |
| dev `.env` の `FIREBASE_PROJECT_ID` | ✅ frontend から同期済 |
| dev `.env` の `GOOGLE_APPLICATION_CREDENTIALS` | ✅ 配置済 |
| Firebase Auth 利用者 | ✅ 3件（provision 済、`emailVerified: true`） |
| dry-run / apply | ✅ plan sha256 一致・`firebase_identity_unique` index 作成済 |
| ブラウザ `/login` 試験 | ✅ Email/Password 有効化後、3利用者とも sign-in → token 検証 → Mongo 照合成功（2026-08-30） |
| 本体起動 | `.dev-runtime-lock` 維持 |

## 1. 隔離 fixture（いま実行可能）

prod / shannon_dev を変更しない。一時 mongod（37031）上で plan → verify → index → apply → 重複拒否まで確認。

```bash
cd /home/azureuser/Shannon-dev
node scripts/probe-user-binding-migration.cjs --isolated-fixture
```

## 2. shannon_dev 準備（Firebase 利用者 + Mongo seed）

### 2a. backend Firebase project 同期

```bash
cd /home/azureuser/Shannon-dev
node scripts/sync-dev-firebase-env.cjs
```

`backend/.env` の `FIREBASE_PROJECT_ID` を `frontend/.env` の `VITE_FIREBASE_PROJECT_ID` と揃える（値は stdout に出さない）。

### 2b. リハーサル利用者定義（Git 外）

```bash
cp backend/scripts/dev-uid-rehearsal-users.example.json backend/scripts/dev-uid-rehearsal-users.json
chmod 600 backend/scripts/dev-uid-rehearsal-users.json
# password を強力な値に置換（manifest/Firebase 用。Git に載せない）
```

### 2c. Mongo seed（Firebase 不要）

```bash
cd /home/azureuser/Shannon-dev/backend
node scripts/prepare-dev-uid-rehearsal.mjs --seed
```

email 一致・`firebaseUid` 空の利用者 3 件を `shannon_dev.users` へ投入する。既存 email があれば再 insert しない。

### 2d. Firebase 利用者作成（ADC 必須）

1. dev Firebase Console から Admin SDK 用サービスアカウント JSON を取得（例: `~/.secrets/shannon-dev-firebase-admin.json`, mode 0600）。
2. `backend/.env` に `GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to.json` を追加。
3. 実行:

```bash
cd /home/azureuser/Shannon-dev/backend
node scripts/prepare-dev-uid-rehearsal.mjs --provision-firebase
node scripts/prepare-dev-uid-rehearsal.mjs --write-manifest
```

`--provision-firebase` は email/password で Firebase Auth 利用者を作成し `emailVerified: true` にする。`dev-uid-rehearsal-users.json` に `uid` を書き戻す。`--write-manifest` は `user-binding-manifest.json`（Git 外）を生成する。

## 3. shannon_dev 向け dry-run（Firebase 不要）

manifest が用意できていれば Firebase 照会なしで plan のみ生成できる（`verifyIdentities` は apply 時）。

1. `backend/scripts/user-binding-manifest.json` を用意（2d または手動編集、mode 0600）。
2. dry-run:

```bash
cd /home/azureuser/Shannon-dev/backend
node scripts/user-binding-migration.mjs /path/to/manifest.json /tmp/uid-plan.json
```

3. Settings → Identity パネル（admin）でも同じ manifest を `validate-manifest` で検証可能。

出力の `sha256` を控え、apply 時に一致確認する。

## 4. shannon_dev 向け apply（dev Firebase + ADC 必須）

前提:

- `backend/.env`: `MONGODB_URI` が `shannon_dev`、`FIREBASE_PROJECT_ID` が dev 専用 project
- `GOOGLE_APPLICATION_CREDENTIALS` が dev project の Admin SDK 鍵
- `FIREBASE_AUTH_EMULATOR_HOST` **未設定**
- VM が `/home/azureuser/Shannon-dev/backend` チェックアウト

```bash
cd /home/azureuser/Shannon-dev/backend
node scripts/user-binding-migration.mjs /path/to/manifest.json /tmp/uid-plan.json \
  --apply EXPECTED_SHA256_FROM_DRY_RUN
```

apply 後:

1. dev frontend `.env` の Firebase project が一致していること
2. Firebase Console → Authentication → Sign-in method → Email/Password が有効であること
3. テスト利用者で `/login` → `auth:check` 成功
4. 管理 console（admin）/ Radar（非 admin）の経路確認

apply 時に plan 出力先が既存だと `EEXIST` で終了コード 1 になるが、DB 更新は完了している場合がある。绑定確認は `db.users` の `firebaseUid` / `firebaseProjectId` を見る。

## 5. 本番移行（別工程・未 apply）

dev リハーサル成功後のみ。prod DB への apply は **Shannon-dev checkout から拒否**（`user-binding-migration.mjs` は `shannon_dev` 限定）。

### 5a. manifest 雛形（読取のみ）

prod `shannon.users` を読取専用で列挙し、レビュー用 template を Git 外へ生成:

```bash
cd /home/azureuser/Shannon-dev/backend
node scripts/prepare-prod-uid-manifest.mjs --read-only \
  --project-id YOUR_PROD_FIREBASE_PROJECT_ID \
  --reviewed-by reviewer-id \
  --out scripts/prod-user-binding-manifest.template.json
```

- 既定 source: `mongodb://127.0.0.1:27017/shannon`（**書込みしない**）
- 出力は mode 0600。`_reviewNotes` に email / 既存 binding 状態を含む

### 5a2. Firebase UID 解決と manifest 確定

```bash
cd /home/azureuser/Shannon-dev/backend
node scripts/fill-prod-uid-manifest.mjs --create-missing   # 未登録 email は Firebase Auth に作成
node scripts/validate-prod-uid-manifest.mjs                 # plan + Firebase 照合（読取のみ）
```

- 出力: `scripts/prod-user-binding-manifest.json`（Git 外、mode 0600）
- `--create-missing` は Firebase Auth に未登録の prod email 向け。初回 Google ログイン前の利用者など
- **2026-08-30:** 3件確定・validate 成功。plan sha256 は apply レビュー用に控える（manifest ファイルと同梱しない）

### 5b. 切替手順

- 書込み停止 → 最終 dump → 隔離 restore でリハーサル
- prod manifest は **prod 利用者3件** の `_id` / レビュー済み UID / 権限を明示
- prod apply は別 checkout・別手順で実施（本 repo の dev スクリプトからは不可）

### 5c. 定期検証（dev）

```bash
cd /home/azureuser/Shannon-dev
node scripts/verify-dev-uid-login.cjs --check-login
```

## 拒否される例

- email からの自動 UID 推論
- 旧 `isAdmin` の暗黙継承（manifest で明示必須）
- 既存 UID の rebind（別レビュー manifest 必須）
- plan hash / projectId 不一致での apply
- Firebase emulator 有効時の apply

## 関連

- `docs/r0-release-readiness.md` — 切替条件
- `docs/refactor-access-foundation.md` — RF-01/02 移行前提
- `backend/tests/unit/userMigration.test.ts` — plan/verify の unit
