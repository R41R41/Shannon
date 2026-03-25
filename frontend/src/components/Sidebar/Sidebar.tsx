import React, { useState } from "react";
import styles from "./Sidebar.module.scss";
import classNames from "classnames";
import SearchOutlinedIcon from "@mui/icons-material/SearchOutlined";
import HandymanOutlinedIcon from "@mui/icons-material/HandymanOutlined";
import ScheduleOutlinedIcon from "@mui/icons-material/ScheduleOutlined";
import TaskAltOutlinedIcon from "@mui/icons-material/TaskAltOutlined";
import SearchTab from "./SearchTab/SearchTab";
import { ILog } from "@common/types/common";
import ScheduleTab from "./ScheduleTab/ScheduleTab";
import StatusTab from "./StatusTab/StatusTab";
import MonitorHeartOutlinedIcon from "@mui/icons-material/MonitorHeartOutlined";
import SkillsTab from "./SkillsTab/SkillsTab";
import { useAgents } from "@/contexts/AgentContext";

interface SidebarProps {
  isMobile?: boolean;
  isTest?: boolean;
}

const Sidebar: React.FC<SidebarProps> = ({
  isMobile = false,
  isTest,
}) => {
  const { userInfo } = useAgents();
  const [activeTab, setActiveTab] = useState("status");
  const [searchResults, setSearchResults] = useState<ILog[]>([]);

  return (
    <div
      className={classNames(styles.sidebarContainer, {
        [styles.mobile]: isMobile,
      })}
    >
      <div
        className={classNames(styles.tabContainer, {
          [styles.mobileTabContainer]: isMobile,
        })}
      >
        <div
          className={classNames(styles.tab, {
            [styles.active]: activeTab === "search",
          })}
          onClick={() => setActiveTab("search")}
          title="検索"
        >
          <SearchOutlinedIcon />
        </div>
        <div
          className={classNames(styles.tab, {
            [styles.active]: activeTab === "skills",
          })}
          onClick={() => setActiveTab("skills")}
          title="スキル"
        >
          <HandymanOutlinedIcon />
        </div>
        <div
          className={classNames(styles.tab, {
            [styles.active]: activeTab === "tasks",
          })}
          onClick={() => setActiveTab("tasks")}
          title="タスク"
        >
          <TaskAltOutlinedIcon />
        </div>
        {(userInfo?.isAdmin || isTest) && (
          <div
            className={classNames(styles.tab, {
              [styles.active]: activeTab === "schedule",
            })}
            onClick={() => setActiveTab("schedule")}
            title="スケジュール"
          >
            <ScheduleOutlinedIcon />
          </div>
        )}
        <div
          className={classNames(styles.tab, {
            [styles.active]: activeTab === "status",
          })}
          onClick={() => setActiveTab("status")}
          title="ステータス"
        >
          <MonitorHeartOutlinedIcon />
        </div>
      </div>
      {!isMobile && (
        <div className={styles.tabContent}>
          {activeTab === "search" && (
            <SearchTab
              searchResults={searchResults}
              setSearchResults={setSearchResults}
            />
          )}
          {activeTab === "skills" && <SkillsTab />}
          {activeTab === "schedule" && <ScheduleTab />}
          {activeTab === "status" && (
            <StatusTab isTest={isTest} />
          )}
        </div>
      )}
    </div>
  );
};

export default Sidebar;
