import React, { useEffect, useState, useMemo } from 'react';
import { useSkill } from '@/contexts/AgentContext';
import { SkillInfo } from '@common/types/llm';
import styles from './SkillsTab.module.scss';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';

const CATEGORY_MAP: Record<string, string> = {
  get: '📊 クエリ',
  list: '📊 クエリ',
  check: '📊 クエリ',
  find: '📊 クエリ',
  investigate: '📊 クエリ',
  can: '📊 クエリ',
  is: '📊 クエリ',
  move: '🚶 移動',
  follow: '🚶 移動',
  flee: '🚶 移動',
  jump: '🚶 移動',
  stop: '🚶 移動',
  look: '🚶 移動',
  enter: '🚶 移動',
  set: '🚶 移動',
  dig: '⛏️ 採掘',
  stair: '⛏️ 採掘',
  fill: '⛏️ 採掘',
  craft: '🔨 クラフト',
  start: '🔨 クラフト',
  attack: '⚔️ 戦闘',
  combat: '⚔️ 戦闘',
  swing: '⚔️ 戦闘',
  plant: '🌾 農業',
  harvest: '🌾 農業',
  breed: '🌾 農業',
  fish: '🌾 農業',
  use: '🎯 その他',
  deposit: '📦 インベントリ',
  withdraw: '📦 インベントリ',
  drop: '📦 インベントリ',
  pickup: '📦 インベントリ',
  place: '🎯 その他',
  activate: '🎯 その他',
  trade: '🎯 その他',
  sleep: '🎯 その他',
  chat: '🎯 その他',
  wait: '🎯 その他',
  switch: '🎯 その他',
};

function categorize(name: string): string {
  const lower = name.toLowerCase().replace(/-/g, '');
  for (const [prefix, cat] of Object.entries(CATEGORY_MAP)) {
    if (lower.startsWith(prefix)) return cat;
  }
  return '🎯 その他';
}

const SkillsTab: React.FC = () => {
  const skill = useSkill();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (skill) {
      const unsubscribe = skill.onUpdateSkills((newSkills) => setSkills(newSkills));
      skill.getSkills();
      return () => { unsubscribe(); };
    }
  }, [skill]);

  const filtered = useMemo(() => {
    if (!search) return skills;
    const q = search.toLowerCase();
    return skills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    );
  }, [skills, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, SkillInfo[]>();
    for (const s of filtered) {
      const cat = categorize(s.name);
      const list = map.get(cat) || [];
      list.push(s);
      map.set(cat, list);
    }
    return map;
  }, [filtered]);

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });
  };

  return (
    <div className={styles.skillsContainer}>
      <div className={styles.searchBar}>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="スキルを検索..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className={styles.countBadge}>{filtered.length}</span>
      </div>

      {Array.from(grouped.entries()).map(([category, categorySkills]) => (
        <div key={category} className={styles.categoryGroup}>
          <div
            className={styles.categoryHeader}
            onClick={() => toggleCategory(category)}
          >
            <span>{category}</span>
            <span className={styles.categoryCount}>{categorySkills.length}</span>
          </div>

          {!collapsedCategories.has(category) &&
            categorySkills.map((s) => (
              <div
                key={s.name}
                className={styles.skillCard}
                onClick={() =>
                  setExpandedSkill(expandedSkill === s.name ? null : s.name)
                }
              >
                <div className={styles.skillHeader}>
                  <div className={styles.skillTitle}>
                    <h3>{s.name}</h3>
                    {expandedSkill === s.name ? (
                      <KeyboardArrowUpIcon fontSize="small" />
                    ) : (
                      <KeyboardArrowDownIcon fontSize="small" />
                    )}
                  </div>
                  <p className={styles.description}>{s.description}</p>
                </div>
                {expandedSkill === s.name && s.parameters.length > 0 && (
                  <div className={styles.parameters}>
                    {s.parameters.map((param) => (
                      <div key={param.name} className={styles.parameter}>
                        <div className={styles.paramName}>{param.name}</div>
                        <div className={styles.paramDesc}>{param.description}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
        </div>
      ))}

      {filtered.length === 0 && (
        <div className={styles.emptyState}>該当するスキルが見つかりません</div>
      )}
    </div>
  );
};

export default SkillsTab;
