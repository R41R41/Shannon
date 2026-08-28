import React, { useEffect, useState } from 'react';
import styles from './SettingsModal.module.scss';
import { authorizedFetch } from '../../features/auth/authorizedFetch';
import { useAuthSession } from '../../features/auth/AuthSession';
import { showToast } from '../Toast/Toast';
import { useTheme, type Theme } from '../../hooks/useTheme';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ModelConfig {
  [key: string]: string;
}

const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const { user } = useAuthSession();
  const [savedModels, setSavedModels] = useState<ModelConfig>({});
  const [models, setModels] = useState<ModelConfig>({});
  const [overrides, setOverrides] = useState<ModelConfig>({});
  const [logCount, setLogCount] = useState(() =>
    parseInt(localStorage.getItem('shannon_log_count') || '200')
  );
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    if (!isOpen || !user?.isAdmin) return;
    authorizedFetch('/api/models')
      .then(r => r.json())
      .then(data => {
        setModels(data.current || {});
        setSavedModels(data.current || {});
        setOverrides(data.overrides || {});
      })
      .catch(() => {});
  }, [isOpen, user?.isAdmin]);

  const handleModelChange = async (key: string, model: string) => {
    try {
      await authorizedFetch(`/api/models/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      setModels(prev => ({ ...prev, [key]: model }));
      setSavedModels(prev => ({ ...prev, [key]: model }));
      setOverrides(prev => ({ ...prev, [key]: model }));
      showToast(`${key} → ${model}`, 'success');
    } catch {
      showToast('モデル変更に失敗しました', 'error');
    }
  };

  const handleResetModels = async () => {
    try {
      const res = await authorizedFetch('/api/models/reset', { method: 'POST' });
      const data = await res.json();
      setModels(data.models || {});
      setSavedModels(data.models || {});
      setOverrides({});
      showToast('全モデルをデフォルトにリセット', 'success');
    } catch {
      showToast('リセットに失敗しました', 'error');
    }
  };

  const handleLogCountSave = () => {
    localStorage.setItem('shannon_log_count', String(logCount));
    showToast(`ログ表示件数: ${logCount}件`, 'info');
  };

  if (!isOpen) return null;

  const modelKeys = Object.keys(models).filter(k => !k.startsWith('minebot.'));
  const minebotKeys = Object.keys(models).filter(k => k.startsWith('minebot.'));

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modalContent} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h2>設定</h2>
          <button className={styles.closeButton} onClick={onClose}>✕</button>
        </div>

        <div className={styles.modalBody}>
          <div className={styles.settingItem}>
            <div className={styles.sectionHeader}>
              <h3>LLM モデル</h3>
              {Object.keys(overrides).length > 0 && (
                <button className={styles.resetButton} onClick={handleResetModels}>
                  リセット
                </button>
              )}
            </div>
            <div className={styles.modelGrid}>
              {modelKeys.map(key => (
                <div key={key} className={styles.modelRow}>
                  <span className={styles.modelKey}>{key}</span>
                  <input
                    className={styles.modelInput}
                    value={models[key] || ''}
                    onChange={e => setModels(prev => ({ ...prev, [key]: e.target.value }))}
                    onBlur={e => {
                      if (e.target.value && e.target.value !== savedModels[key]) {
                        handleModelChange(key, e.target.value);
                      }
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                  />
                  {overrides[key] && <span className={styles.overrideBadge}>変更済</span>}
                </div>
              ))}
            </div>
            {minebotKeys.length > 0 && (
              <>
                <h4 className={styles.subSection}>Minebot</h4>
                <div className={styles.modelGrid}>
                  {minebotKeys.map(key => (
                    <div key={key} className={styles.modelRow}>
                      <span className={styles.modelKey}>{key.replace('minebot.', '')}</span>
                      <input
                        className={styles.modelInput}
                        value={models[key] || ''}
                        onChange={e => setModels(prev => ({ ...prev, [key]: e.target.value }))}
                        onBlur={e => {
                          if (e.target.value) handleModelChange(key, e.target.value);
                        }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        }}
                      />
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className={styles.settingItem}>
            <h3>表示設定</h3>
            <div className={styles.modelRow}>
              <span className={styles.modelKey}>テーマ</span>
              <div className={styles.themeToggle}>
                {(['dark', 'light'] as Theme[]).map((t) => (
                  <button
                    key={t}
                    className={`${styles.themeBtn} ${theme === t ? styles.active : ''}`}
                    onClick={() => { setTheme(t); showToast(`テーマ: ${t}`, 'info'); }}
                  >
                    {t === 'dark' ? '🌙 ダーク' : '☀️ ライト'}
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.modelRow}>
              <span className={styles.modelKey}>ログ表示件数</span>
              <input
                className={styles.modelInput}
                type="number"
                min={50}
                max={1000}
                step={50}
                value={logCount}
                onChange={e => setLogCount(parseInt(e.target.value) || 200)}
                onBlur={handleLogCountSave}
              />
            </div>
          </div>
        </div>

        <div className={styles.modalFooter}>
          <button className={styles.cancelButton} onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;