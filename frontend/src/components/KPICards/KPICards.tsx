import { useEffect, useState } from 'react';
import styles from './KPICards.module.scss';

interface KPIData {
  label: string;
  value: string;
  sub: string;
  icon: string;
  color: string;
}

const INITIAL_CARDS: KPIData[] = [
  { label: '稼働サービス', value: '-', sub: '', icon: '🤖', color: 'info' },
  { label: '本日の投稿', value: '-', sub: 'スケジュール', icon: '🐦', color: 'success' },
  { label: 'トークン消費', value: '-', sub: '本日', icon: '🎯', color: 'warning' },
  { label: '接続状態', value: '-', sub: '', icon: '🔗', color: 'primary' },
];

export const KPICards: React.FC = () => {
  const [cards, setCards] = useState<KPIData[]>(INITIAL_CARDS);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [healthRes, tokenRes, scheduleRes] = await Promise.allSettled([
          fetch('/api/health').then(r => r.json()),
          fetch('/api/tokens/today').then(r => r.json()),
          fetch('/api/twitter/schedule').then(r => r.json()),
        ]);

        setCards(prev => {
          const next = [...prev];
          if (healthRes.status === 'fulfilled') {
            next[0] = { ...next[0], value: 'OK', sub: '正常' };
            next[3] = { ...next[3], value: '接続中', sub: 'WebSocket' };
          }
          if (tokenRes.status === 'fulfilled') {
            const data = tokenRes.value;
            const totalK = data.totalTokens ? `${(data.totalTokens / 1000).toFixed(1)}K` : '0';
            next[2] = { ...next[2], value: totalK, sub: `${data.callCount || 0}回のAPI呼出（本日累計）` };
          }
          if (scheduleRes.status === 'fulfilled') {
            const sched = scheduleRes.value;
            const total = sched.times?.length || 0;
            const posted = sched.postedCount || 0;
            next[1] = { ...next[1], value: `${posted}/${total}`, sub: `スケジュール (${sched.date || '---'})` };
          }
          return next;
        });
      } catch {
        // API unavailable
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className={styles.grid}>
      {cards.map((card, i) => (
        <div key={i} className={`${styles.card} ${styles[card.color]}`}>
          <div className={styles.icon}>{card.icon}</div>
          <div className={styles.content}>
            {isLoading ? (
              <>
                <div className={styles.skeleton} style={{ width: '60px', height: '20px' }} />
                <div className={styles.label}>{card.label}</div>
                <div className={styles.skeleton} style={{ width: '80px', height: '12px', marginTop: '3px' }} />
              </>
            ) : (
              <>
                <div className={styles.value}>{card.value}</div>
                <div className={styles.label}>{card.label}</div>
                {card.sub && <div className={styles.sub}>{card.sub}</div>}
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};
