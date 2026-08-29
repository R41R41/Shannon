import React, { useCallback, useEffect, useState } from 'react';
import type { AudienceUpdateRequest, BindingManifestPlanResponse, IdentityStatusResponse } from '@shannon/common';
import { authorizedFetch } from '../auth/authorizedFetch';
import styles from '../../components/Modal/SettingsModal.module.scss';

interface IdentityPanelProps {
  isAdmin: boolean;
  isOpen: boolean;
}

const reloadStatus = async (): Promise<IdentityStatusResponse> => {
  const response = await authorizedFetch('/api/identity/status');
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<IdentityStatusResponse>;
};

export const IdentityPanel: React.FC<IdentityPanelProps> = ({ isAdmin, isOpen }) => {
  const [status, setStatus] = useState<IdentityStatusResponse | null>(null);
  const [manifestText, setManifestText] = useState('');
  const [plan, setPlan] = useState<BindingManifestPlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmWrite, setConfirmWrite] = useState(false);
  const [discordUserId, setDiscordUserId] = useState('');
  const [lineUserId, setLineUserId] = useState('');
  const [minecraftServerId, setMinecraftServerId] = useState('');
  const [minecraftWorldId, setMinecraftWorldId] = useState('');
  const [minecraftPlayerUuid, setMinecraftPlayerUuid] = useState('');
  const [audienceDraft, setAudienceDraft] = useState<AudienceUpdateRequest | null>(null);

  const refresh = useCallback(async () => {
    const next = await reloadStatus();
    setStatus(next);
    setAudienceDraft({
      confirm: true,
      memoryChannels: [...next.audience.memoryChannels],
      lineDeliveryEnabled: next.audience.lineDeliveryEnabled,
      radarPersonalFeed: next.audience.radarPersonalFeed,
    });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    refresh().catch(() => setError('Identity 状態の取得に失敗しました'));
  }, [isOpen, refresh]);

  const requireConfirm = () => {
    if (!confirmWrite) throw new Error('明示確認にチェックを入れてください');
  };

  const linkChannel = async (channel: string, body: Record<string, unknown>) => {
    setError(null);
    try {
      requireConfirm();
      const response = await authorizedFetch(`/api/identity/bindings/${channel}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, ...body }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? String(response.status));
      setStatus(payload as IdentityStatusResponse);
      setConfirmWrite(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '連携に失敗しました');
    }
  };

  const unlinkChannel = async (channel: string) => {
    setError(null);
    try {
      requireConfirm();
      const response = await authorizedFetch(`/api/identity/bindings/${channel}/unlink`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? String(response.status));
      setStatus(payload as IdentityStatusResponse);
      setConfirmWrite(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '連携解除に失敗しました');
    }
  };

  const saveAudience = async () => {
    if (!audienceDraft) return;
    setError(null);
    try {
      requireConfirm();
      const response = await authorizedFetch('/api/identity/audience', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(audienceDraft),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? String(response.status));
      setStatus(payload as IdentityStatusResponse);
      setConfirmWrite(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Audience 更新に失敗しました');
    }
  };

  const validateManifest = async () => {
    setError(null);
    setPlan(null);
    try {
      const manifest = JSON.parse(manifestText);
      const response = await authorizedFetch('/api/identity/validate-manifest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? String(response.status));
      setPlan(body as BindingManifestPlanResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'manifest 検証に失敗しました');
    }
  };

  const bindingFor = (channel: string) => status?.bindings.find((row) => row.channel === channel);

  return (
    <div className={styles.settingItem}>
      <h3>Identity / Binding / Audience</h3>
      {error && <p className={styles.identityError}>{error}</p>}
      <label className={styles.identityConfirmRow}>
        <input type="checkbox" checked={confirmWrite} onChange={(e) => setConfirmWrite(e.target.checked)} />
        変更内容を理解し、明示的に連携・解除・Audience 更新を行います
      </label>
      {status && (
        <>
          <div className={styles.modelRow}>
            <span className={styles.modelKey}>Web Identity</span>
            <span>{status.identity.projectId} / {status.identity.uid}</span>
          </div>
          <div className={styles.identityBindings}>
            {status.bindings.map((binding) => (
              <div key={binding.channel} className={styles.modelRow}>
                <span className={styles.modelKey}>{binding.channel}</span>
                <span>{binding.status} — {binding.label}</span>
              </div>
            ))}
          </div>

          <h4 className={styles.subSection}>チャネル連携（明示入力）</h4>
          <div className={styles.identityFormBlock}>
            <span className={styles.modelKey}>Discord ユーザー ID</span>
            <input className={styles.modelInput} value={discordUserId} onChange={(e) => setDiscordUserId(e.target.value)} placeholder="17〜20桁の snowflake" />
            <div className={styles.identityActions}>
              <button type="button" className={styles.resetButton} onClick={() => linkChannel('discord', { discordUserId })}>Discord を連携</button>
              {bindingFor('discord')?.status === 'linked' && (
                <button type="button" className={styles.cancelButton} onClick={() => unlinkChannel('discord')}>解除</button>
              )}
            </div>
          </div>
          <div className={styles.identityFormBlock}>
            <span className={styles.modelKey}>LINE ユーザー ID</span>
            <input className={styles.modelInput} value={lineUserId} onChange={(e) => setLineUserId(e.target.value)} placeholder="U + 32桁 hex" />
            <div className={styles.identityActions}>
              <button type="button" className={styles.resetButton} onClick={() => linkChannel('line', { lineUserId })}>LINE を連携</button>
              {bindingFor('line')?.status === 'linked' && (
                <button type="button" className={styles.cancelButton} onClick={() => unlinkChannel('line')}>解除</button>
              )}
            </div>
          </div>
          <div className={styles.identityFormBlock}>
            <span className={styles.modelKey}>Minecraft serverId / worldId</span>
            <input className={styles.modelInput} value={minecraftServerId} onChange={(e) => setMinecraftServerId(e.target.value)} placeholder="dev:server-a" />
            <input className={styles.modelInput} value={minecraftWorldId} onChange={(e) => setMinecraftWorldId(e.target.value)} placeholder="world-a" />
            <input className={styles.modelInput} value={minecraftPlayerUuid} onChange={(e) => setMinecraftPlayerUuid(e.target.value)} placeholder="player UUID（任意）" />
            <div className={styles.identityActions}>
              <button type="button" className={styles.resetButton} onClick={() => linkChannel('minecraft', {
                serverId: minecraftServerId,
                worldId: minecraftWorldId,
                playerUuid: minecraftPlayerUuid || undefined,
              })}>Minecraft を連携</button>
              {bindingFor('minecraft')?.status === 'linked' && (
                <button type="button" className={styles.cancelButton} onClick={() => unlinkChannel('minecraft')}>解除</button>
              )}
            </div>
          </div>
          <div className={styles.identityFormBlock}>
            <span className={styles.modelKey}>Radar owner</span>
            <div className={styles.identityActions}>
              <button type="button" className={styles.resetButton} onClick={() => linkChannel('radar', {})}>Firebase UID で Radar owner を連携</button>
              {bindingFor('radar')?.status === 'linked' && (
                <button type="button" className={styles.cancelButton} onClick={() => unlinkChannel('radar')}>解除</button>
              )}
            </div>
          </div>

          {audienceDraft && (
            <>
              <h4 className={styles.subSection}>Audience（記憶・配信）</h4>
              <div className={styles.identityFormBlock}>
                {(['discord_text', 'web'] as const).map((channel) => (
                  <label key={channel} className={styles.identityConfirmRow}>
                    <input
                      type="checkbox"
                      checked={audienceDraft.memoryChannels.includes(channel)}
                      onChange={(e) => setAudienceDraft((prev) => prev && ({
                        ...prev,
                        memoryChannels: e.target.checked
                          ? [...new Set([...prev.memoryChannels, channel])]
                          : prev.memoryChannels.filter((value) => value !== channel),
                      }))}
                    />
                    記憶: {channel}
                  </label>
                ))}
                <label className={styles.identityConfirmRow}>
                  <input
                    type="checkbox"
                    checked={audienceDraft.lineDeliveryEnabled}
                    onChange={(e) => setAudienceDraft((prev) => prev && ({ ...prev, lineDeliveryEnabled: e.target.checked }))}
                  />
                  LINE 配信を有効化（binding 済みの場合のみ将来利用）
                </label>
                <label className={styles.identityConfirmRow}>
                  <input
                    type="checkbox"
                    checked={audienceDraft.radarPersonalFeed}
                    onChange={(e) => setAudienceDraft((prev) => prev && ({ ...prev, radarPersonalFeed: e.target.checked }))}
                  />
                  Radar 個人 feed を有効化
                </label>
                <button type="button" className={styles.resetButton} onClick={saveAudience}>Audience を保存</button>
              </div>
            </>
          )}
        </>
      )}
      {isAdmin && (
        <>
          <h4 className={styles.subSection}>UID 移行 manifest（dry-run）</h4>
          <textarea
            className={styles.manifestInput}
            rows={8}
            value={manifestText}
            onChange={(e) => setManifestText(e.target.value)}
            placeholder='{"version":1,"projectId":"...","reviewedBy":"...","bindings":[]}'
          />
          <button className={styles.resetButton} type="button" onClick={validateManifest}>
            manifest を検証
          </button>
          {plan && (
            <div className={styles.identityPlan}>
              <p>operations: {plan.operationCount}, unboundAfter: {plan.unboundAfter}</p>
              <p>sha256: {plan.sha256}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default IdentityPanel;
