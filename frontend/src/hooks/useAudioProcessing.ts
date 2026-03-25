import { AudioQueueManager } from '@components/ChatView/AudioManager';
import { useEffect } from 'react';
import { OpenAIAgent } from '@/services/agents/openaiAgent';

export const useAudioProcessing = (
  openaiService: OpenAIAgent,
  audioQueueManager: AudioQueueManager
) => {
  useEffect(() => {
    if (!openaiService) return;

    const unsubscribe = openaiService.onAudio((base64Data: string) => {
      const binaryString = atob(base64Data);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const int16Array = new Int16Array(bytes.buffer);
      audioQueueManager.addAudioToQueue(int16Array);
    });

    return () => {
      unsubscribe();
    };
  }, [openaiService, audioQueueManager]);
};
