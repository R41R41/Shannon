import { CommonFcaControlLoop } from './controlLoop.js';
import { NativeCommonFcaBody } from './nativeBody.js';
import { createBodyImageCapture } from './imageCapture.js';

export function createCommonFcaBody(bot: any, settings: { url: string; serverId: string }, token: string,
  rendererDirectory?: string): CommonFcaControlLoop {
  const images = createBodyImageCapture(bot, { rendererDirectory });
  const actuator = new NativeCommonFcaBody(bot, { serverId: settings.serverId,
    capture: signal => images.capture(signal), disposeCapture: () => images.dispose() });
  const loop = new CommonFcaControlLoop({ baseUrl: settings.url, token, serverId: settings.serverId, actuator });
  const end = () => { void loop.stop(); };
  bot.once('end', end);
  return loop;
}
