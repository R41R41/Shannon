import React, { useEffect, useState } from 'react';
import type { BindingManifestPlanResponse, IdentityStatusResponse } from '@shannon/common';
import { authorizedFetch } from '../auth/authorizedFetch';
import styles from '../../components/Modal/SettingsModal.module.scss';

interface IdentityPanelProps {
  isAdmin: boolean;
  isOpen: boolean;
}

export const IdentityPanel: React.FC<IdentityPanelProps> = ({ isAdmin, isOpen }) => {
  const [status, setStatus] = useState<IdentityStatusResponse | null>(null);
  const [manifestText, setManifestText] = useState('');
  const [plan, setPlan] = useState<BindingManifestPlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    authorizedFetch('/api/identity/status')
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<IdentityStatusResponse>;
      })
      .then(setStatus)
      .catch(() => setError('Identity 状態の取得に失敗しました'));
  }, [isOpen]);

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

  return (
    <div className={styles.settingItem}>
      <h3>Identity / Binding / Audience</h3>
      {error && <p className={styles.identityError}>{error}</p>}
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
          <div className={styles.modelRow}>
            <span className={styles.modelKey}>記憶チャネル</span>
            <span>{status.audience.memoryChannels.join(', ')}</span>
          </div>
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
