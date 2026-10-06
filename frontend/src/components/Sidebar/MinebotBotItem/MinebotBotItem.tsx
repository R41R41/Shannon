import React, { useState, useEffect } from "react";
import { ServiceStatus } from "@common/types/common";
import styles from "./MinebotBotItem.module.scss";
import classNames from "classnames";

interface MinebotBotItemProps {
  status: ServiceStatus;
  onToggle: (serviceId: string) => void;
  onServerSelect: (serverName: string) => void;
}

const SERVERS = [
  { id: "1.21.11-fabric-youtube", label: "1.21.11-fabric-youtube" },
  { id: "1.21.4-test", label: "1.21.4-test" },
  { id: "1.19.0-youtube", label: "1.19.0-youtube" },
  { id: "1.21.1-play", label: "1.21.1-play" },
  { id: "1.21.11-fabric-test", label: "1.21.11-fabric-test" },
  { id: "shannon-home", label: "shannon-home" },
];

export const MinebotBotItem: React.FC<MinebotBotItemProps> = ({
  status,
  onToggle,
  onServerSelect,
}) => {
  const [showServerList, setShowServerList] = useState(false);
  const isRunning = status === "running";
  const isConnecting = status === "connecting";

  useEffect(() => {
    if (!showServerList) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (
        !target.closest(`.${styles.serverDropdown}`) &&
        !target.closest(`.${styles.toggle}`)
      ) {
        setShowServerList(false);
      }
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [showServerList]);

  const handleToggleClick = () => {
    if (isRunning) {
      onToggle("minebot:bot");
    } else {
      setShowServerList(!showServerList);
    }
  };

  return (
    <div
      className={classNames(styles.serviceItem, {
        [styles.stopped]: !isRunning && !isConnecting,
      })}
    >
      <div className={styles.info}>
        <span className={styles.name}>Minebot Bot</span>
        <span className={classNames(styles.statusText, styles[status])}>
          <span className={styles.statusDot} />
          {status}
        </span>
      </div>

      <div className={styles.controlWrapper}>
        <button
          className={classNames(styles.toggle, {
            [styles.active]: isRunning,
          })}
          onClick={handleToggleClick}
          disabled={isConnecting}
          title={isRunning ? "停止" : "サーバー選択"}
        >
          <span className={styles.toggleThumb} />
        </button>

        {showServerList && (
          <div className={styles.serverDropdown}>
            {SERVERS.map((server) => (
              <button
                key={server.id}
                className={styles.serverOption}
                onClick={() => {
                  onServerSelect(server.id);
                  setShowServerList(false);
                }}
              >
                {server.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
