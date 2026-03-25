import { OpenAIAgent } from '@/services/agents/openaiAgent';

export const convertFloat32ToInt16 = (buffer: Float32Array): ArrayBuffer => {
  let l = buffer.length;
  const buf = new Int16Array(l);
  while (l--) {
    buf[l] = Math.min(1, buffer[l]) * 0x7fff;
  }
  return buf.buffer;
};

export const startRecording = async (
  setIsRecording: (isRecording: boolean) => void,
  processorRef: React.MutableRefObject<ScriptProcessorNode | null>,
  openaiService: OpenAIAgent | null
) => {
  try {
    setIsRecording(true);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
      },
    });

    const audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (event) => {
      const audioData = event.inputBuffer.getChannelData(0);
      const int16Buffer = convertFloat32ToInt16(audioData);
      openaiService?.sendVoiceData(
        new Blob([int16Buffer], { type: 'audio/pcm' })
      );
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
    processorRef.current = processor;
  } catch (error) {
    console.error('録音開始時にエラーが発生しました:', error);
    setIsRecording(false);
  }
};

export const stopRecording = (
  setIsRecording: (isRecording: boolean) => void,
  openaiService: OpenAIAgent | null,
  processorRef: React.MutableRefObject<ScriptProcessorNode | null>
) => {
  setIsRecording(false);
  if (processorRef.current) {
    openaiService?.commitAudioBuffer();
    processorRef.current.disconnect();
    processorRef.current = null;
  }
};

export const stopRecordingWithoutCommit = (
  processorRef: React.MutableRefObject<ScriptProcessorNode | null>,
  setIsRecording: (isRecording: boolean) => void
) => {
  setIsRecording(false);
  if (processorRef.current) {
    processorRef.current.disconnect();
    processorRef.current = null;
  }
};
