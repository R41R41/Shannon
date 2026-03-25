import { ConnectionStatus } from "@/services/common/WebSocketClient";
import { ServiceStatus } from "@common/types/common";
import { useAgents } from "@/contexts/AgentContext";
import React, { useCallback, useEffect, useState } from "react";
import { MinebotBotItem } from "../MinebotBotItem/MinebotBotItem";
import { ServiceItem } from "../ServiceItem/ServiceItem";
import styles from "./StatusTab.module.scss";

interface StatusTabProps {
  isTest?: boolean;
}

interface ServiceStatuses {
  [key: string]: ServiceStatus;
}

// Service definitions with categories
const SERVICE_CATEGORIES = [
  {
    label: "Social",
    services: [
      { id: "twitter", name: "Twitter Bot" },
      { id: "discord", name: "Discord Bot" },
      { id: "youtube", name: "YouTube Bot" },
      { id: "youtube:live_chat", name: "YouTube Live Chat" },
    ],
  },
  {
    label: "Minecraft",
    services: [
      { id: "minecraft", name: "Minecraft Client" },
      { id: "minecraft:1.21.11-fabric-youtube", name: "MC 1.21.11-fabric-youtube" },
      { id: "minecraft:1.19.0-youtube", name: "MC 1.19.0-youtube" },
      { id: "minecraft:1.21.4-test", name: "MC 1.21.4-test" },
      { id: "minecraft:1.21.1-play", name: "MC 1.21.1-play" },
      { id: "minecraft:1.21.11-fabric-test", name: "MC 1.21.11-fabric-test" },
    ],
  },
  {
    label: "Minebot",
    services: [
      { id: "minebot", name: "Minebot Client" },
      // minebot:bot is handled separately (MinebotBotItem)
    ],
  },
];

const ALL_SERVICE_IDS: string[] = [
  ...SERVICE_CATEGORIES.flatMap((cat) => cat.services.map((s) => s.id)),
  "minebot:bot",
];

const INITIAL_STATUSES: ServiceStatuses = Object.fromEntries(
  ALL_SERVICE_IDS.map((id) => [id, "stopped" as ServiceStatus])
);

const STORAGE_KEY = "statusTab:collapsedCategories";

function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export const StatusTab: React.FC<StatusTabProps> = ({
  isTest,
}) => {
  const { status, userInfo } = useAgents();
  const [serviceStatuses, setServiceStatuses] =
    useState<ServiceStatuses>(INITIAL_STATUSES);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("disconnected");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);

  const toggleCategory = useCallback((label: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [label]: !prev[label] };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // Track WebSocket connection for re-fetch on reconnect
  useEffect(() => {
    if (!status) return;
    const listener = (newStatus: ConnectionStatus) =>
      setConnectionStatus(newStatus);
    status.addStatusListener(listener);
    setConnectionStatus(status.status);
    return () => status.removeStatusListener(listener);
  }, [status]);

  // Fetch service statuses on connect/reconnect
  useEffect(() => {
    if (!status || connectionStatus !== "connected") return;

    ALL_SERVICE_IDS.forEach((service) => {
      status.getStatusService(service);
    });

    const cleanupFunctions = ALL_SERVICE_IDS.map((service) => {
      return status.onServiceStatus(service, (newStatus) => {
        setServiceStatuses((prev) => ({ ...prev, [service]: newStatus }));
      });
    });

    return () => {
      cleanupFunctions.forEach((cleanup) => cleanup());
    };
  }, [status, connectionStatus]);

  const handleToggle = async (service: string) => {
    if (!status) return;
    const serviceStatus = serviceStatuses[service];
    if (serviceStatus === "running") {
      await status.stopService(service);
    } else if (service !== "minebot:bot") {
      await status.startService(service);
    }
  };

  const handleMinebotBotStart = async (serverName: string) => {
    await status?.startService("minebot:bot", { serverName });
  };

  const isAdmin = userInfo?.isAdmin || isTest;

  return (
    <div className={styles.container}>
      <span className={styles.title}>Services</span>

      {isAdmin && (
        <div className={styles.categoryList}>
          {SERVICE_CATEGORIES.map((category) => {
            const isCollapsed = !!collapsed[category.label];
            return (
              <div key={category.label} className={styles.category}>
                <button
                  type="button"
                  className={styles.categoryToggle}
                  onClick={() => toggleCategory(category.label)}
                  aria-expanded={!isCollapsed}
                >
                  <span className={`${styles.chevron} ${isCollapsed ? styles.collapsed : ""}`}>&#9662;</span>
                  <span className={styles.categoryLabel}>{category.label}</span>
                </button>
                {!isCollapsed && (
                  <div className={styles.serviceList}>
                    {category.services.map((service) => (
                      <ServiceItem
                        key={service.id}
                        name={service.name}
                        status={serviceStatuses[service.id]}
                        serviceId={service.id}
                        statusAgent={status}
                        onToggle={handleToggle}
                      />
                    ))}
                    {category.label === "Minebot" && (
                      <MinebotBotItem
                        status={serviceStatuses["minebot:bot"]}
                        onToggle={handleToggle}
                        onServerSelect={handleMinebotBotStart}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!isAdmin && (
        <div className={styles.categoryList}>
          <div className={styles.category}>
            <div className={styles.serviceList}>
              <ServiceItem
                name="Minecraft 1.21.1-play"
                status={serviceStatuses["minecraft:1.21.1-play"]}
                serviceId="minecraft:1.21.1-play"
                statusAgent={status}
                onToggle={handleToggle}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default StatusTab;
