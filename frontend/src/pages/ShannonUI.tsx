import React, { useState, useEffect, useMemo } from "react";
import styles from "./ShannonUI.module.scss";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import Sidebar from "@components/Sidebar/Sidebar";
import MainContent from "@components/MainContent/MainContent";
import ChatView from "@components/ChatView/ChatView";
import Header from "@components/Header/Header";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";

const ResizeHandle = ({ direction = "vertical" }: { direction?: "vertical" | "horizontal" }) => (
  <PanelResizeHandle
    className={direction === "vertical" ? styles.resizeHandleV : styles.resizeHandleH}
  />
);

interface ShannonUIProps {
  isTest?: boolean;
}

const ShannonUI: React.FC<ShannonUIProps> = ({ isTest }) => {
  const [isMobile, setIsMobile] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const shortcuts = useMemo(() => ({
    'Ctrl+,': () => setSettingsOpen((v) => !v),
    'Escape': () => setSettingsOpen(false),
  }), []);
  useKeyboardShortcuts(shortcuts);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return (
    <div className={styles.container}>
      <Header
        settingsOpen={settingsOpen}
        onSettingsChange={setSettingsOpen}
      />
      <div className={styles.mainSection}>
        {isMobile ? (
          <div className={styles.mobileLayout}>
            <div className={styles.mobileContent}>
              <MainContent isMobile={true} />
            </div>
            <div className={styles.mobileChatView}>
              <ChatView />
            </div>
            <div className={styles.mobileNavbar}>
              <Sidebar isMobile={true} isTest={isTest} />
            </div>
          </div>
        ) : (
          <PanelGroup direction="horizontal">
            <Panel defaultSize={18} minSize={14}>
              <Sidebar isTest={isTest} />
            </Panel>
            <ResizeHandle direction="horizontal" />
            <Panel defaultSize={62} minSize={30}>
              <MainContent />
            </Panel>
            <ResizeHandle direction="horizontal" />
            <Panel defaultSize={20} minSize={15}>
              <ChatView />
            </Panel>
          </PanelGroup>
        )}
      </div>
    </div>
  );
};

export default ShannonUI;
