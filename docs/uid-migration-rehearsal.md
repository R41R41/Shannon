# UID 移行リハーサル（dev）

本番 `users` 3件はすべて `firebaseUid` 未設定。本番切替前に **dev 専用 Firebase + shannon_dev** で dry-run → apply → ログイン確認まで通す。

## 現状（2026-08-30）

| 項目 | 状態 |
|---|---|
| 移行スクリプト | `backend/scripts/user-binding-migration.mjs` 実装済み |
| Settings manifest dry-run | `POST /api/identity/validate-manifest` 実装済み |
| 隔離 fixture リハーサル | ✅ `scripts/probe-user-binding-migration.cjs --isolated-fixture` 成功（2026-08-30） |
| prod `shannon.users` | 3件・UID 未绑定（読取確認のみ、書込みしない） |
| dev `shannon_dev.users` | 空（実リハーサル前に seed または手動登録が必要） |
| dev `.env` の `FIREBASE_PROJECT_ID` / ADC | **未設定** → live apply は未実施 |
| 本体起動 | `.dev-runtime-lock` 維持 |

## 1. 隔離 fixture（いま実行可能）

prod / shannon_dev を変更しない。一時 mongod（37031）上で plan → verify → index → apply → 重複拒否まで確認。

```bash
cd /home/azureuser/Shannon-dev
node scripts/probe-user-binding-migration.cjs --isolated-fixture
```

## 2. shannon_dev 向け dry-run（Firebase 不要）

1. dev Firebase Console でテスト利用者を作成し、**UID と email（verified）** を控える（Git/Notion に載せない）。
2. `shannon_dev.users` に対応する利用者レコードを用意（email 一致、UID フィールドは空のまま）。
3. `backend/scripts/user-binding-manifest.example.json` をコピーし、manifest を編集（mode 0600、Git 外推奨）。
4. dry-run:

```bash
cd /home/azureuser/Shannon-dev/backend
node scripts/user-binding-migration.mjs /path/to/manifest.json /tmp/uid-plan.json
```

5. Settings → Identity パネル（admin）でも同じ manifest を `validate-manifest` で検証可能。

出力の `sha256` を控え、apply 時に一致確認する。

## 3. shannon_dev 向け apply（dev Firebase + ADC 必須）

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
2. テスト利用者で `/login` → `auth:check` 成功
3. 管理 console（admin）/ Radar（非 admin）の経路確認

## 4. 本番移行（別工程・未実施）

- 書込み停止 → 最終 dump → 隔離 restore でリハーサル
- prod manifest は **prod 利用者3件** の `_id` / レビュー済み UID / 権限
- prod apply は shannon_dev リハーサル成功後のみ

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
