import React, { useState, useEffect } from "react";
import styles from "./SearchTab.module.scss";
import { ILog } from "@common/types/common";
import { MemoryZone } from "@common/types/common";
import { useMonitoring } from "@/contexts/AgentContext";

interface SearchTabProps {
  searchResults: ILog[];
  setSearchResults: (results: ILog[]) => void;
}

const SearchTab: React.FC<SearchTabProps> = ({
  searchResults,
  setSearchResults,
}) => {
  const monitoring = useMonitoring();
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [memoryZone, setMemoryZone] = useState<MemoryZone | "">("");
  const [content, setContent] = useState("");

  useEffect(() => {
    const unsubscribe = monitoring?.onSearchResults((results) => {
      setSearchResults(results);
    });

    return () => {
      unsubscribe?.();
    };
  }, [setSearchResults, monitoring]);

  // 検索条件が変更されるたびに検索を実行
  useEffect(() => {
    monitoring?.searchLogs({
      startDate,
      endDate,
      memoryZone,
      content,
    });
  }, [startDate, endDate, memoryZone, content, monitoring]);

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

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.title}>Search Logs</span>
        {searchResults.length > 0 && (
          <span className={styles.resultCount}>{searchResults.length}件</span>
        )}
      </div>
      <div className={styles.searchForm}>
        <div className={styles.dateRow}>
          <input
            type="datetime-local"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            placeholder="開始日時"
            className={styles.input}
          />
          <span className={styles.dateSep}>〜</span>
          <input
            type="datetime-local"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            placeholder="終了日時"
            className={styles.input}
          />
        </div>
        <select
          value={memoryZone}
          onChange={(e) => setMemoryZone(e.target.value as MemoryZone)}
          className={`${styles.input} ${styles.select}`}
        >
          <option value="">全ての記憶領域</option>
          <option value="web">ShannonUI</option>
          <option value="discord:toyama_server">discord:とやまさば</option>
          <option value="discord:aiminelab_server">discord:アイマイラボ！</option>
          <option value="discord:test_server">discord:テスト用サーバー</option>
          <option value="discord:douki_server">discord:どうきさば</option>
          <option value="minecraft">minecraft</option>
          <option value="twitter:schedule_post">twitter:スケジュール投稿</option>
          <option value="twitter:post">twitter:通常投稿</option>
          <option value="youtube">youtube</option>
        </select>
        <input
          type="text"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="🔍 検索キーワード"
          className={styles.input}
        />
      </div>
      <div className={styles.results}>
        {searchResults.length === 0 ? (
          <div className={styles.emptyState}>
            {content || startDate || endDate || memoryZone
              ? "該当するログが見つかりません"
              : "検索条件を入力してください"}
          </div>
        ) : (
          searchResults.map((log, index) => (
            <div key={index} className={styles.logEntry}>
              <div className={styles.logHeader}>
                <span className={styles.timestamp}>
                  {formatTimestamp(log.timestamp)}
                </span>
                <span className={styles.platform}>{log.memoryZone}</span>
              </div>
              <span className={`${styles.content} ${styles[log.color]}`}>
                {formatContent(log.content)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default SearchTab;
