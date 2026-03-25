import React, { useRef, memo } from "react";
import { AudioQueueManager } from "./AudioManager.ts";
import { useAudioProcessing } from "@/hooks/useAudioProcessing";
import { PushToTalkButton } from "./components/PushToTalkButton/PushToTalkButton";
import { ChatScope } from "./components/ChatScope/ChatScope.tsx";
import "./ChatView.scss";
import { useAgents } from "@/contexts/AgentContext";

const ChatView: React.FC = memo(() => {
  const { openai } = useAgents();
  const audioQueueManager = useRef(new AudioQueueManager()).current;

  useAudioProcessing(openai, audioQueueManager);

  return (
    <div className="chat-sidebar">
      <ChatScope />
      <PushToTalkButton />
    </div>
  );
});

ChatView.displayName = "ChatView";

export default ChatView;
