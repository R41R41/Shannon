import React from "react";
import styles from "./MainContent.module.scss";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import ActivityLog from "@/components/ActivityLog/ActivityLog";
import StatusLog from "@/components/StatusLog/StatusLog";

interface MainContentProps {
  isMobile?: boolean;
}

const ResizeHandle = () => (
  <PanelResizeHandle className={styles.resizeHandle} />
);

const MainContent: React.FC<MainContentProps> = ({
  isMobile = false,
}) => {
  return (
    <div className={styles.container}>
      {isMobile ? (
        <StatusLog isMobile={true} />
      ) : (
        <PanelGroup direction="vertical">
          <Panel defaultSize={40} minSize={20}>
            <StatusLog />
          </Panel>
          <ResizeHandle />
          <Panel defaultSize={60} minSize={30}>
            <ActivityLog />
          </Panel>
        </PanelGroup>
      )}
    </div>
  );
};

export default MainContent;
