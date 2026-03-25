import { useState, useEffect } from "react";
import {
  MainContainer,
  ChatContainer,
  MessageList,
  Message,
  MessageInput,
  TypingIndicator,
  InputToolbox,
} from "@chatscope/chat-ui-kit-react";
import "@chatscope/chat-ui-kit-styles/dist/default/styles.min.css";
import "./ChatScope.scss";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import { useChatHistory } from "@/hooks/useChatHistory";
import { useAgents } from "@/contexts/AgentContext";

export const ChatScope: React.FC = () => {
  const { openai, userInfo } = useAgents();
  const [isTyping] = useState(false);
  const { messages: savedMessages, addMessage: saveToChatHistory } = useChatHistory();
  const [chatMessages, setChatMessages] = useState<BaseMessage[]>(() => {
    return savedMessages.map((m) =>
      m.sender === 'user' ? new HumanMessage(m.text) : new AIMessage(m.text)
    );
  });
  const [processingChatMessageIndex, setProcessingChatMessageIndex] =
    useState<number>(0);
  const [isRealTimeChat, setIsRealTimeChat] = useState(false);

  const handleSendMessage = async (message: string) => {
    try {
      // HTML要素を除去してプレーンテキストに変換
      const cleanMessage = message
        .replace(/<br\s*\/?>/g, "\n") // <br>タグを改行に変換
        .replace(/&lt;/g, "<") // &lt; を < に変換
        .replace(/&gt;/g, ">") // &gt; を > に変換
        .replace(/&amp;/g, "&") // &amp; を & に変換
        .replace(/&quot;/g, '"') // &quot; を " に変換
        .replace(/&#39;/g, "'") // &#39; を ' に変換
        .replace(/&nbsp;/g, " ") // &nbsp; を空白に変換
        .replace(/&#x2F;/g, "/") // &#x2F; を / に変換
        .replace(/<[^>]*>/g, "") // その他のHTMLタグを除去
        .trim();
      const currentTime = new Date().toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo",
      });

      const formattedMsg = currentTime + " " + (userInfo?.name ? userInfo.name : "User") + ": " + cleanMessage;
      setChatMessages((prev) => [...prev, new HumanMessage(formattedMsg)]);
      saveToChatHistory('user', cleanMessage);

      const senderName = userInfo?.name ? userInfo.name : "User";

      if (openai) {
        await openai.sendMessage(
          senderName,
          cleanMessage,
          isRealTimeChat,
          chatMessages.slice(-10)
        );
      }
    } catch (error) {
      console.error("メッセージの送信に失敗しました:", error);
    }
  };

  useEffect(() => {
    if (!openai) return;

    const unsubText = openai.onText((text: string) => {
      const modifiedText = text.replace(/\\n/g, "\n");
      setChatMessages((prev) => {
        const lastMessage = prev[prev.length - 1];
        if (lastMessage && lastMessage instanceof AIMessage) {
          return [
            ...prev.slice(0, -1),
            new AIMessage(lastMessage.content + modifiedText),
          ];
        } else {
          const currentTime = new Date().toLocaleString("ja-JP", {
            timeZone: "Asia/Tokyo",
          });
          return [
            ...prev,
            new AIMessage(currentTime + " " + "AI:" + " " + modifiedText),
          ];
        }
      });
    });

    const unsubTextDone = openai.onTextDone(() => {
      setChatMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last instanceof AIMessage && typeof last.content === 'string') {
          saveToChatHistory('ai', last.content);
        }
        return prev;
      });
      setProcessingChatMessageIndex((prev) => prev + 1);
    });

    const unsubUserTranscript = openai.onUserTranscript((text: string) => {
      const currentTime = new Date().toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo",
      });
      setChatMessages((prev) => [
        ...prev,
        new HumanMessage(
          currentTime +
            " " +
            (userInfo?.name ? userInfo.name : "User") +
            ":" +
            " " +
            text
        ),
      ]);
    });

    return () => {
      unsubText();
      unsubTextDone();
      unsubUserTranscript();
    };
  }, [openai, userInfo, saveToChatHistory]);

  return (
    <MainContainer>
      <ChatContainer>
        <MessageList
          typingIndicator={
            isTyping ? (
              <TypingIndicator
                content={`${
                  chatMessages[chatMessages.length - 1] instanceof HumanMessage
                    ? "User"
                    : "AI"
                }が入力中...`}
              />
            ) : null
          }
        >
          {chatMessages.map((msg, index) => (
            <Message
              key={index}
              model={{
                message:
                  msg instanceof HumanMessage
                    ? String(msg.content).split(
                        userInfo?.name ? userInfo.name + ": " : "User: "
                      )[1]
                    : String(msg.content).split("AI: ")[1],
                sentTime: "just now",
                sender: msg instanceof HumanMessage ? "User" : "AI",
                direction:
                  msg instanceof HumanMessage ? "outgoing" : "incoming",
                position: "single",
              }}
              className="copyable-message"
            />
          ))}
        </MessageList>
        <MessageInput
          placeholder="メッセージを入力..."
          onSend={handleSendMessage}
          sendButton={false}
          attachButton={false}
        />
        <InputToolbox>
          <label className="switch">
            <input
              type="checkbox"
              checked={isRealTimeChat}
              onChange={(e) => setIsRealTimeChat(e.target.checked)}
            />
            <span className="slider"></span>
          </label>
          <span>Realtime API</span>
        </InputToolbox>
      </ChatContainer>
    </MainContainer>
  );
};
