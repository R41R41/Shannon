import React, { createContext, useContext, useEffect, useState, useMemo } from "react";
import { MonitoringAgent } from "@/services/agents/monitoringAgent";
import { OpenAIAgent } from "@/services/agents/openaiAgent";
import { SchedulerAgent } from "@/services/agents/schedulerAgent";
import { StatusAgent } from "@/services/agents/statusAgent";
import { PlanningAgent } from "@/services/agents/planningAgent";
import { EmotionAgent } from "@/services/agents/emotionAgent";
import { SkillAgent } from "@/services/agents/skillAgent";
import { AuthAgent } from "@/services/agents/authAgent";
import { WebClient } from "@/services/client";
import { UserInfo } from "@common/types/web";

export interface AgentContextType {
  monitoring: MonitoringAgent | null;
  openai: OpenAIAgent | null;
  status: StatusAgent | null;
  planning: PlanningAgent | null;
  emotion: EmotionAgent | null;
  scheduler: SchedulerAgent | null;
  skill: SkillAgent | null;
  auth: AuthAgent | null;
  userInfo: UserInfo | null;
}

const AgentContext = createContext<AgentContextType | null>(null);

export const AgentProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [monitoring, setMonitoring] = useState<MonitoringAgent | null>(null);
  const [openai, setOpenai] = useState<OpenAIAgent | null>(null);
  const [scheduler, setScheduler] = useState<SchedulerAgent | null>(null);
  const [status, setStatus] = useState<StatusAgent | null>(null);
  const [planning, setPlanning] = useState<PlanningAgent | null>(null);
  const [emotion, setEmotion] = useState<EmotionAgent | null>(null);
  const [skill, setSkill] = useState<SkillAgent | null>(null);
  const [auth, setAuth] = useState<AuthAgent | null>(null);

  useEffect(() => {
    const storedUserInfo = localStorage.getItem("userInfo");
    if (storedUserInfo) {
      setUserInfo(JSON.parse(storedUserInfo));
    }

    const webClient = WebClient.getInstance();
    setMonitoring(webClient.monitoringService);
    setOpenai(webClient.openaiService);
    setScheduler(webClient.schedulerService);
    setStatus(webClient.statusService);
    setPlanning(webClient.planningService);
    setEmotion(webClient.emotionService);
    setSkill(webClient.skillService);
    setAuth(webClient.authService);

    if (!webClient.isConnected()) {
      webClient.start();
    }

    return () => {
      webClient.disconnect();
    };
  }, []);

  const value = useMemo<AgentContextType>(
    () => ({
      monitoring,
      openai,
      status,
      planning,
      emotion,
      scheduler,
      skill,
      auth,
      userInfo,
    }),
    [monitoring, openai, status, planning, emotion, scheduler, skill, auth, userInfo],
  );

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
};

// General hook to access all agents
export function useAgents(): AgentContextType {
  const ctx = useContext(AgentContext);
  if (!ctx) {
    throw new Error("useAgents must be used within an AgentProvider");
  }
  return ctx;
}

// Focused hooks for individual agents
export function useMonitoring(): MonitoringAgent | null {
  return useAgents().monitoring;
}

export function useOpenAI(): OpenAIAgent | null {
  return useAgents().openai;
}

export function useStatus(): StatusAgent | null {
  return useAgents().status;
}

export function usePlanning(): PlanningAgent | null {
  return useAgents().planning;
}

export function useEmotion(): EmotionAgent | null {
  return useAgents().emotion;
}

export function useScheduler(): SchedulerAgent | null {
  return useAgents().scheduler;
}

export function useSkill(): SkillAgent | null {
  return useAgents().skill;
}
