import React, { useState } from "react";
import styles from "./Header.module.scss";
import SettingsModal from "@components/Modal/SettingsModal";
import logo from "@/assets/logo.png";
import SettingsIcon from "@mui/icons-material/Settings";
import { ConnectionStatus } from "@/services/common/WebSocketClient";
import { useConnectionStatus } from "@/hooks/useConnectionStatus";
import { useAgents } from "@/contexts/AgentContext";
import classNames from "classnames";

interface HeaderProps {
  settingsOpen?: boolean;
  onSettingsChange?: (open: boolean) => void;
}

interface ConnectionIndicatorProps {
  label: string;
  status: ConnectionStatus;
}

const ConnectionIndicator: React.FC<ConnectionIndicatorProps> = ({
  label,
  status,
}) => (
  <div className={styles.connectionItem} title={`${label}: ${status}`}>
    <span
      className={classNames(styles.connectionDot, {
        [styles.connected]: status === "connected",
        [styles.connecting]: status === "connecting",
        [styles.disconnected]: status === "disconnected",
      })}
    />
    <span className={styles.connectionLabel}>{label}</span>
  </div>
);

const Header: React.FC<HeaderProps> = ({
  settingsOpen: externalSettingsOpen,
  onSettingsChange,
}) => {
  const { monitoring, openai, status, userInfo } = useAgents();
  const [internalModalOpen, setInternalModalOpen] = useState(false);
  const isModalOpen = externalSettingsOpen ?? internalModalOpen;
  const setIsModalOpen = (open: boolean) => {
    setInternalModalOpen(open);
    onSettingsChange?.(open);
  };
  const monitoringStatus = useConnectionStatus(monitoring);
  const openaiStatus = useConnectionStatus(openai);
  const statusStatus = useConnectionStatus(status);

  return (
    <>
      <header className={styles.header}>
        <div className={styles.leftSection}>
          <img src={logo} alt="Shannon Logo" className={styles.logo} />
          <span className={styles.version}>SHANNON-v2.2</span>
        </div>

        <div className={styles.centerSection}>
          <ConnectionIndicator label="Monitor" status={monitoringStatus} />
          <ConnectionIndicator label="OpenAI" status={openaiStatus} />
          <ConnectionIndicator label="Status" status={statusStatus} />
        </div>

        <div className={styles.rightSection}>
          {userInfo?.name && (
            <span className={styles.userName}>{userInfo.name}</span>
          )}
          <button
            className={styles.settingsButton}
            onClick={() => setIsModalOpen(true)}
            title="設定"
          >
            <SettingsIcon />
          </button>
        </div>
      </header>

      <SettingsModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
      />
    </>
  );
};

export default Header;
