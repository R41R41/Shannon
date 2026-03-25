import React from "react";
import styles from "./StatusLog.module.scss";
import TaskTree from "./TaskTree/TaskTree";
import Emotion from "./Emotion/Emotion";
import { KPICards } from "../KPICards/KPICards";
import classNames from "classnames";

interface StatusLogProps {
  isMobile?: boolean;
}

const StatusLog: React.FC<StatusLogProps> = ({
  isMobile = false,
}) => {
  return (
    <div
      className={classNames(styles.container, {
        [styles.mobile]: isMobile,
      })}
    >
      <KPICards />
      <div className={styles.panelGrid}>
        <TaskTree isMobile={isMobile} />
        <Emotion isMobile={isMobile} />
      </div>
    </div>
  );
};

export default StatusLog;
