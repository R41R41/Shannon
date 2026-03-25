import React, { useEffect, useState, useRef } from "react";
import styles from "./ActivityLog.module.scss";
import { ILog, MemoryZone } from "@common/types/common";
import { useMonitoring } from "@/contexts/AgentContext";
import { showToast } from "@components/Toast/Toast";
import classNames from "classnames";

const ZONE_COLORS: Record<string, string> = {
  minecraft: 'zone-minecraft',
  discord: 'zone-discord',
  twitter: 'zone-twitter',
  youtube: 'zone-youtube',
  web: 'zone-web',
};

const getZoneColor = (zone: string): string => {
  const key = Object.keys(ZONE_COLORS).find(k => zone.startsWith(k));
  return key ? ZONE_COLORS[key] : 'zone-default';
};

interface FilterTab {
  label: string;
  value: MemoryZone | "";
}

const FILTER_TABS: FilterTab[] = [
  { label: "All", value: "" },
  { label: "ShannonUI", value: "web" },
  { label: "Minecraft", value: "minecraft" },
  { label: "Twitter", value: "twitter:schedule_post" },
  { label: "YouTube", value: "youtube" },
];

const DISCORD_SERVERS = [
  {
    label: "全サーバー",
    value: "discord" as MemoryZone,
  },
  {
    label: "とやまさば",
    value: "discord:toyama_server" as MemoryZone,
  },
  {
    label: "アイマイラボ！",
    value: "discord:aiminelab_server" as MemoryZone,
  },
  {
    label: "テスト用サーバー",
    value: "discord:test_server" as MemoryZone,
  },
  {
    label: "どうきさば",
    value: "discord:douki_server" as MemoryZone,
  },
];

const ActivityLog: React.FC = () => {
  const monitoring = useMonitoring();
  const [logs, setLogs] = useState<ILog[]>([]);
  const [selectedMemoryZone, setSelectedMemoryZone] = useState<
    MemoryZone | ""
  >("");
  const [showDiscordMenu, setShowDiscordMenu] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [levelFilter, setLevelFilter] = useState<"all" | "error" | "warn">("all");
  const logListRef = useRef<HTMLDivElement>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const [maxLogs, setMaxLogs] = useState(() =>
    parseInt(localStorage.getItem('shannon_log_count') || '200')
  );

  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'shannon_log_count' && e.newValue) {
        setMaxLogs(parseInt(e.newValue));
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  useEffect(() => {
    const unsubscribe = monitoring?.onLog((log: ILog) => {
      setLogs((prevLogs) => {
        const newLogs = [...prevLogs, log].slice(-maxLogs);
        if (shouldAutoScroll) {
          setTimeout(() => {
            logListRef.current?.scrollTo({
              top: logListRef.current.scrollHeight,
              behavior: "smooth",
            });
          }, 0);
        }
        return newLogs;
      });
    });

    return () => {
      unsubscribe?.();
    };
  }, [monitoring, shouldAutoScroll, maxLogs]);

  useEffect(() => {
    if (monitoring?.status === "connected") {
      const fetchAllMemoryZoneLogs = async () => {
        try {
          const allMemoryZoneLogs = await monitoring?.getAllMemoryZoneLogs();
          if (allMemoryZoneLogs) {
            setLogs([...allMemoryZoneLogs].reverse());
          }
        } catch (error) {
          console.error("Failed to fetch all memory zone logs:", error);
        }
      };
      fetchAllMemoryZoneLogs();
    }
  }, [monitoring?.status, monitoring]);

  const handleScroll = () => {
    if (!logListRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logListRef.current;
    setShouldAutoScroll(scrollHeight - scrollTop - clientHeight < 20);
  };

  const formatContent = (content: string) => {
    return content.split("\n").map((line, i) => (
      <React.Fragment key={i}>
        {line}
        {i < content.split("\n").length - 1 && <br />}
      </React.Fragment>
    ));
  };

  const formatTimestamp = (timestamp: Date) => {
    return new Intl.DateTimeFormat("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .format(new Date(timestamp))
      .replace(/\//g, "-");
  };

  const filteredLogs = logs.filter((log) => {
    if (selectedMemoryZone !== "" && !log.memoryZone.includes(selectedMemoryZone)) return false;
    if (levelFilter === "error" && log.color !== "red") return false;
    if (levelFilter === "warn" && log.color !== "yellow" && log.color !== "red") return false;
    if (searchText && !log.content.toLowerCase().includes(searchText.toLowerCase())) return false;
    return true;
  });

  const isErrorLog = (log: ILog) => log.color === "red";
  const isWarningLog = (log: ILog) => log.color === "yellow";

  return (
    <div className={styles.container}>
      {/* Filter tabs */}
      <div className={styles.tabBar}>
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.value || "all"}
            className={classNames(styles.tab, {
              [styles.active]: selectedMemoryZone === tab.value,
            })}
            onClick={() => setSelectedMemoryZone(tab.value)}
          >
            {tab.label}
          </button>
        ))}

        {/* Discord dropdown */}
        <div
          className={styles.dropdownWrapper}
          onMouseEnter={() => setShowDiscordMenu(true)}
          onMouseLeave={() => setShowDiscordMenu(false)}
        >
          <button
            className={classNames(styles.tab, {
              [styles.active]:
                selectedMemoryZone.startsWith("discord"),
            })}
          >
            Discord
          </button>
          {showDiscordMenu && (
            <div className={styles.dropdown}>
              {DISCORD_SERVERS.map((server) => (
                <button
                  key={server.value}
                  className={classNames(styles.dropdownItem, {
                    [styles.active]: selectedMemoryZone === server.value,
                  })}
                  onClick={() => {
                    setSelectedMemoryZone(server.value);
                    setShowDiscordMenu(false);
                  }}
                >
                  {server.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Search & level filter bar */}
      <div className={styles.filterBar}>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="ログを検索..."
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
        />
        <div className={styles.levelButtons}>
          {(["all", "warn", "error"] as const).map((level) => (
            <button
              key={level}
              className={classNames(styles.levelBtn, {
                [styles.active]: levelFilter === level,
                [styles.levelWarn]: level === "warn",
                [styles.levelError]: level === "error",
              })}
              onClick={() => setLevelFilter(level)}
            >
              {level === "all" ? "全て" : level === "warn" ? "⚠️" : "❌"}
            </button>
          ))}
        </div>
        <span className={styles.logCount}>{filteredLogs.length}</span>
      </div>

      {/* Log list */}
      <div
        ref={logListRef}
        className={styles.logList}
        onScroll={handleScroll}
      >
        {filteredLogs.map((log, index) => (
          <div
            key={index}
            className={classNames(styles.logEntry, {
              [styles.errorEntry]: isErrorLog(log),
              [styles.warningEntry]: isWarningLog(log),
            })}
            onClick={() => {
              navigator.clipboard.writeText(log.content).then(() => {
                showToast('コピーしました', 'success', 1500);
              }).catch(() => {});
            }}
            title="クリックでコピー"
          >
            <span className={styles.timestamp}>
              {formatTimestamp(log.timestamp)}
            </span>
            {selectedMemoryZone === "" && (
              <span className={classNames(styles.zoneBadge, styles[getZoneColor(log.memoryZone)])}>
                {log.memoryZone}
              </span>
            )}
            <span className={classNames(styles.content, styles[log.color])}>
              {formatContent(log.content)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ActivityLog;
