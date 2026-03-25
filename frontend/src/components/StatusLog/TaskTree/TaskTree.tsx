import React, { useState, useEffect } from "react";
import styles from "./TaskTree.module.scss";
import { TaskTreeState } from "@common/types/taskGraph";
import { usePlanning } from "@/contexts/AgentContext";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import HourglassEmptyIcon from "@mui/icons-material/HourglassEmpty";
import AutorenewIcon from "@mui/icons-material/Autorenew";
import classNames from "classnames";

interface TaskTreeProps {
  isMobile?: boolean;
}

const StatusIcon: React.FC<{ status: string }> = ({ status }) => {
  switch (status) {
    case "completed":
      return <CheckCircleOutlineIcon className={classNames(styles.statusIcon, styles.completed)} />;
    case "error":
      return <ErrorOutlineIcon className={classNames(styles.statusIcon, styles.error)} />;
    case "in_progress":
      return <AutorenewIcon className={classNames(styles.statusIcon, styles.inProgress)} />;
    default:
      return <HourglassEmptyIcon className={classNames(styles.statusIcon, styles.pending)} />;
  }
};

const statusLabel = (status: string) => {
  switch (status) {
    case "completed":
      return "Completed";
    case "error":
      return "Error";
    case "in_progress":
      return "In Progress";
    default:
      return "Pending";
  }
};

const TaskTree: React.FC<TaskTreeProps> = ({ isMobile }) => {
  const planning = usePlanning();
  const [taskTree, setTaskTree] = useState<TaskTreeState | null>(null);
  const [lastCompleted, setLastCompleted] = useState<string | null>(null);

  useEffect(() => {
    if (planning) {
      const unsubscribe = planning.onUpdatePlanning((taskTree) => {
        if (taskTree?.status === 'completed' && taskTree.goal) {
          setLastCompleted(taskTree.goal);
        }
        setTaskTree(taskTree);
      });
      return () => { unsubscribe(); };
    }
  }, [planning]);

  const hasData = taskTree && taskTree.goal;

  return (
    <div className={classNames(styles.card, { [styles.mobile]: isMobile })}>
      <div className={styles.cardHeader}>
        <span className={styles.cardTitle}>Planning</span>
        {taskTree?.status && (
          <span
            className={classNames(styles.statusBadge, styles[taskTree.status])}
          >
            {statusLabel(taskTree.status)}
          </span>
        )}
      </div>

      {hasData ? (
        <div className={styles.content}>
          <div className={styles.goalSection}>
            <StatusIcon status={taskTree.status ?? "pending"} />
            <span className={styles.goalText}>{taskTree.goal}</span>
          </div>

          {taskTree.subTasks && taskTree.subTasks.length > 0 && (() => {
            const total = taskTree.subTasks.length;
            const completed = taskTree.subTasks.filter(t => t.subTaskStatus === 'completed').length;
            const errors = taskTree.subTasks.filter(t => t.subTaskStatus === 'error').length;
            const pct = Math.round((completed / total) * 100);
            return (
              <div className={styles.progressSection}>
                <div className={styles.progressBar}>
                  <div className={styles.progressFill} style={{ width: `${pct}%` }} />
                  {errors > 0 && (
                    <div className={styles.progressError} style={{ width: `${Math.round((errors / total) * 100)}%` }} />
                  )}
                </div>
                <span className={styles.progressText}>{completed}/{total} 完了{errors > 0 ? ` (${errors}エラー)` : ''}</span>
              </div>
            );
          })()}

          {taskTree.strategy && (
            <div className={styles.strategyText}>{taskTree.strategy}</div>
          )}

          {taskTree.error && (
            <div className={styles.errorBox}>
              <ErrorOutlineIcon className={styles.errorIcon} />
              <span>{taskTree.error}</span>
            </div>
          )}

          {taskTree.subTasks && taskTree.subTasks.length > 0 && (
            <div className={styles.subTaskList}>
              {taskTree.subTasks.map((subTask, index) => (
                <div
                  key={`${subTask.subTaskGoal}-${index}`}
                  className={styles.subTaskItem}
                >
                  <StatusIcon status={subTask.subTaskStatus} />
                  <div className={styles.subTaskContent}>
                    <span className={styles.subTaskGoal}>
                      {subTask.subTaskGoal}
                    </span>
                    {subTask.subTaskStrategy && (
                      <span className={styles.subTaskStrategy}>
                        {subTask.subTaskStrategy}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className={styles.emptyState}>
          <HourglassEmptyIcon className={styles.emptyIcon} />
          <span className={styles.emptyLabel}>待機中</span>
          {lastCompleted && (
            <div className={styles.lastCompleted}>
              <CheckCircleOutlineIcon className={styles.lastCompletedIcon} />
              <span>{lastCompleted}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default TaskTree;
