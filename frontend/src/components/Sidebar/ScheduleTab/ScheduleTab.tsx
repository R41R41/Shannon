import React, { useState, useEffect } from 'react';
import { Schedule } from '@common/types/scheduler';
import { useScheduler } from '@/contexts/AgentContext';
import styles from './ScheduleTab.module.scss';
import cronstrue from 'cronstrue';
import ja from 'cronstrue/locales/ja';
import { showToast } from '../../Toast/Toast';

const SCHEDULE_ICONS: Record<string, string> = {
  fortune: '🔮',
  forecast: '🌤️',
  about_today: '📅',
  news: '📰',
  auto_tweet: '🐦',
  youtube: '📺',
  default: '⏰',
};

function getIcon(name: string): string {
  const lower = name.toLowerCase();
  for (const [key, icon] of Object.entries(SCHEDULE_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return SCHEDULE_ICONS.default;
}

const ScheduleTab: React.FC = () => {
  const scheduler = useScheduler();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [executing, setExecuting] = useState<string | null>(null);

  useEffect(() => {
    if (scheduler?.status === 'connected') {
      const fetchAllSchedules = async () => {
        try {
          const result = await scheduler?.getAllSchedules();
          if (result) setSchedules(result);
        } catch (error) {
          console.error('Failed to fetch schedules:', error);
        }
      };
      fetchAllSchedules();
    }
  }, [scheduler]);

  const handleExecute = async (name: string) => {
    if (!scheduler) return;
    setExecuting(name);
    try {
      await scheduler.callSchedule(name);
      showToast(`${name} を実行しました`, 'success');
    } catch {
      showToast(`${name} の実行に失敗しました`, 'error');
    } finally {
      setExecuting(null);
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.title}>Schedules</span>
        <span className={styles.countBadge}>{schedules.length}</span>
      </div>
      <div className={styles.scheduleList}>
        {schedules.length === 0 ? (
          <div className={styles.emptyState}>スケジュールがありません</div>
        ) : (
          schedules.map((schedule) => (
            <div key={schedule.name} className={styles.scheduleItem}>
              <span className={styles.icon}>{getIcon(schedule.name)}</span>
              <div className={styles.info}>
                <span className={styles.name}>{schedule.name}</span>
                <span className={styles.time}>
                  {cronstrue.toString(schedule.time, {
                    locale: ja,
                    verbose: true,
                    use24HourTimeFormat: true,
                  })}
                </span>
              </div>
              <button
                className={styles.executeButton}
                onClick={() => handleExecute(schedule.name)}
                disabled={executing === schedule.name}
              >
                {executing === schedule.name ? '...' : '▶'}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default ScheduleTab;
