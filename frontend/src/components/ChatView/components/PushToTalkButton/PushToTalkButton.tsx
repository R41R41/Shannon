import React, { useState, useRef, useEffect } from 'react';
import styles from './PushToTalkButton.module.scss';
import {
  startRecording,
  stopRecording,
  stopRecordingWithoutCommit,
} from '@/utils/audioUtils';
import { useOpenAI } from '@/contexts/AgentContext';
import KeyboardVoiceOutlinedIcon from '@mui/icons-material/KeyboardVoiceOutlined';

export const PushToTalkButton: React.FC = () => {
  const openai = useOpenAI();
  const [isRecording, setIsRecording] = useState(false);
  const [isVadMode, setIsVadMode] = useState(false);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const recordingTimeoutRef = useRef<number | null>(null);
  const mouseDownTargetRef = useRef<EventTarget | null>(null);

  // 録音開始時にタイマーをセット
  const startRecordingWithTimeout = () => {
    console.log('\x1b[34mstartRecordingWithTimeout\x1b[0m');
    startRecording(setIsRecording, processorRef, openai);
    // 30秒後に録音を停止
    recordingTimeoutRef.current = window.setTimeout(() => {
      if (isRecording) {
        stopRecording(setIsRecording, openai, processorRef);
      }
    }, 30000);
  };

  // 録音停止時にタイマーをクリア
  const stopRecordingAndClearTimeout = () => {
    console.log('\x1b[34mstopRecordingAndClearTimeout\x1b[0m');
    if (recordingTimeoutRef.current) {
      clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }
    stopRecording(setIsRecording, openai, processorRef);
  };

  // コンポーネントのクリーンアップ
  useEffect(() => {
    return () => {
      if (recordingTimeoutRef.current) {
        clearTimeout(recordingTimeoutRef.current);
      }
    };
  }, []);

  const onPushToTalk = (event: React.MouseEvent) => {
    if (event.type === 'mousedown') {
      mouseDownTargetRef.current = event.target;
      if (!isRecording) {
        startRecordingWithTimeout();
      }
    } else if (event.type === 'mouseup') {
      // マウスダウンとアップが同じ要素で発生した場合のみ処理
      if (event.target === mouseDownTargetRef.current && isRecording) {
        stopRecordingAndClearTimeout();
      }
      mouseDownTargetRef.current = null;
    }
  };

  const onVadModeChange = () => {
    openai?.vadModeChange(!isVadMode);
    setIsVadMode(!isVadMode);
    if (isRecording) {
      stopRecordingWithoutCommit(processorRef, setIsRecording);
    } else {
      startRecordingWithTimeout();
    }
  };

  return (
    <div
      className={`${styles.pushToTalkButtonContainer} ${
        isRecording || isVadMode ? styles.active : ''
      }`}
    >
      <button
        onMouseDown={isVadMode ? undefined : (e) => onPushToTalk(e)}
        onMouseUp={isVadMode ? undefined : (e) => onPushToTalk(e)}
        onMouseLeave={() => {
          // ドラッグ中にボタンの外に出た場合は録音を停止
          if (isRecording && mouseDownTargetRef.current) {
            stopRecordingAndClearTimeout();
            mouseDownTargetRef.current = null;
          }
        }}
        className={`${styles.pushToTalkButton} ${
          isRecording || isVadMode ? styles.active : ''
        }`}
      >
        <KeyboardVoiceOutlinedIcon />
        {isRecording || isVadMode ? 'Recording...' : 'Push to Talk'}
      </button>
      <div
        className={`${styles.recordingIndicator} ${
          isRecording || isVadMode ? styles.active : ''
        }`}
        onClick={onVadModeChange}
      />
    </div>
  );
};
