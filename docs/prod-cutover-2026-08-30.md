# 本番 UID 切替記録（2026-08-30）

状態：**本番 apply・新コード deploy・admin ログイン確認まで完了**。

## 実施内容

| 項目 | 結果 |
|---|---|
| 書込み停止 | prod tmux 停止後、作業完了後に再起動 |
| Mongo バックアップ | `/home/azureuser/backups/shannon-pre-uid-20260829T233446Z` |
| prod UID apply | `shannon.users` 3件・`firebase_identity_unique` index |
| deploy | `Shannon-prod` → `codex/shannon-foundation` @ `0808ad49` 以降 |
| nginx 443 | frontend **3001** / API **5001** / WS **5021–5028**（旧 3000/501x から更新） |
| ログイン確認 | admin（`a.ryo0523@gmail.com`）・管理画面・Radar |

## スクリプト

- dev apply: `backend/scripts/apply-prod-user-binding.mjs --production-cutover MANIFEST PLAN [--apply SHA256]`
- prod env 同期: `scripts/sync-prod-firebase-env.cjs`
- nginx: `/etc/nginx/sites-enabled/shannon.conf`（Git 外。`sites-enabled` に backup を置かない）

## 未実施（意図的）

- 非 admin 2人の本人ログイン試験（別タイミング）
- prod 専用 Firebase Admin SDK 鍵への移行（現状 dev ADC パス参照）
- `/api/ready` LLM 初期化失敗の解消（health は ok）

## 関連

- [UID 移行リハーサル](uid-migration-rehearsal.md)
- [R0 リリース準備](r0-release-readiness.md)
