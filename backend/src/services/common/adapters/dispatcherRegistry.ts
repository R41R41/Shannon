import type { ActionDispatcher, ShannonChannel } from '@shannon/common';
import { discordDispatcher } from './discordDispatcher.js';
import { minebotDispatcher } from './minebotDispatcher.js';
import { webDispatcher } from './webDispatcher.js';
import { xDispatcher } from './xDispatcher.js';

const dispatchers = new Map<ShannonChannel, ActionDispatcher>([
  ['discord', discordDispatcher],
  ['minecraft', minebotDispatcher],
  ['web', webDispatcher],
  ['x', xDispatcher],
]);

export function getActionDispatcher(channel: ShannonChannel): ActionDispatcher | null {
  return dispatchers.get(channel) ?? null;
}
