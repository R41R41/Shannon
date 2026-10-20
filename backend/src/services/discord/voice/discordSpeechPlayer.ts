import { StreamType, createAudioResource, type AudioPlayer, type AudioResource } from '@discordjs/voice';
import { SpeechPlayer } from './speechPlayer.js';

/**
 * The guild's AudioPlayer behind `SpeechPlayer`. Raw 48 kHz stereo s16le goes through `StreamType.Raw`, which needs
 * @discordjs/opus or opusscript to encode (both are dependencies); there is no ffmpeg step.
 */
export function createDiscordSpeechPlayer(audioPlayer: AudioPlayer): SpeechPlayer {
  return new SpeechPlayer({
    port: {
      play: (resource) => { audioPlayer.play(resource as AudioResource); },
      stop: (force) => { audioPlayer.stop(force); },
      onStateChange: (listener) => {
        const handler = (_old: { status: string }, next: { status: string }) => listener(next.status);
        audioPlayer.on('stateChange', handler);
        return () => { audioPlayer.off('stateChange', handler); };
      },
      onError: (listener) => {
        audioPlayer.on('error', listener);
        return () => { audioPlayer.off('error', listener); };
      },
    },
    createResource: (stream) => createAudioResource(stream, { inputType: StreamType.Raw }),
  });
}
