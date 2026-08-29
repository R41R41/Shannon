import {
  Schedule,
  SchedulerInput,
  SchedulerOutput,
  TwitterClientInput,
} from '@shannon/common';
import fs from 'fs';
import cron from 'node-cron';
import { BaseClient } from '../common/BaseClient.js';
import { deliverScheduledPostToLlm } from '../runtime/llmInboundDispatch.js';
import { getTwitterToolPort } from '../runtime/platformToolGateway.js';
import { registerSchedulerPort } from '../runtime/schedulerGateway.js';
import { YoutubeClient } from '../youtube/client.js';
import { getWebNotificationHub } from '../web/webNotificationHub.js';
import { logger } from '../../utils/logger.js';

export class Scheduler extends BaseClient {
  private static instance: Scheduler;
  private schedules: Schedule[];
  public isTest: boolean = false;
  private portRegistered = false;

  public static getInstance(isTest: boolean = false) {
    if (!Scheduler.instance) {
      Scheduler.instance = new Scheduler('scheduler', isTest);
    }
    Scheduler.instance.isTest = isTest;
    return Scheduler.instance;
  }

  constructor(serviceName: 'scheduler', isTest: boolean = false) {
    super(serviceName);
    this.schedules = [];
  }

  public async initialize() {
    await this.setUpSchedule();
    this.registerPort();
    await this.schedule();
  }

  private registerPort() {
    if (this.portRegistered) return;
    this.portRegistered = true;

    registerSchedulerPort({
      getSchedule: (input) => this.getSchedule(input),
      callSchedule: (input) => this.callSchedule(input),
      listSchedules: () => this.schedules,
    });
  }

  private async setUpSchedule() {
    this.schedules = JSON.parse(
      fs.readFileSync('saves/schedule.json', 'utf8')
    ) as Schedule[];
  }

  public async getSchedule(_data: SchedulerInput) {
    getWebNotificationHub().emitPostSchedule({
      type: 'post_schedule',
      data: this.schedules,
    } as SchedulerOutput);
  }

  public async callSchedule(data: SchedulerInput) {
    const platform = data.name?.split(':')[0];
    const name = data.name?.split(':')[1];
    logger.info(`Calling schedule: ${platform} ${name}`, 'blue');
    if (platform && name) {
      if (platform === 'twitter' && name === 'check_replies') {
        await getTwitterToolPort().checkReplies();
      } else if (platform === 'twitter') {
        deliverScheduledPostToLlm({
          command: name,
        } as TwitterClientInput);
      } else if (platform === 'youtube' && name === 'check_comments') {
        await YoutubeClient.getInstance().checkComments();
      } else if (platform === 'youtube' && name === 'check_subscribers') {
        await YoutubeClient.getInstance().checkSubscribers();
      }
    }
  }

  private async schedule() {
    this.schedules.forEach((schedule) => {
      cron.schedule(schedule.time, () => {
        void this.callSchedule({ type: 'call_schedule', name: schedule.name });
      });
    });
  }
}
