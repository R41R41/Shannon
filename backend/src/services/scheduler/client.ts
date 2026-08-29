import {
  Schedule,
  SchedulerInput,
  SchedulerOutput,
  TwitterClientInput,
  YoutubeClientInput,
} from '@shannon/common';
import fs from 'fs';
import cron from 'node-cron';
import { BaseClient } from '../common/BaseClient.js';
import { getEventBus } from '../eventBus/index.js';
import { deliverScheduledPostToLlm } from '../runtime/llmInboundDispatch.js';
import { getWebNotificationHub } from '../web/webNotificationHub.js';
import { logger } from '../../utils/logger.js';

export class Scheduler extends BaseClient {
  private static instance: Scheduler;
  private schedules: Schedule[];
  public isTest: boolean = false;

  public static getInstance(isTest: boolean = false) {
    const eventBus = getEventBus();
    if (!Scheduler.instance) {
      Scheduler.instance = new Scheduler('scheduler', isTest);
    }
    Scheduler.instance.isTest = isTest;
    return Scheduler.instance;
  }

  constructor(serviceName: 'scheduler', isTest: boolean = false) {
    const eventBus = getEventBus();
    super(serviceName, eventBus);
    this.schedules = [];
  }

  public async initialize() {
    await this.setUpSchedule();
    await this.setupEventBus();
    await this.schedule();
  }

  private async setUpSchedule() {
    this.schedules = JSON.parse(
      fs.readFileSync('saves/schedule.json', 'utf8')
    ) as Schedule[];
  }

  private async setupEventBus() {
    this.eventBus.subscribe('scheduler:get_schedule', (event) => {
      this.post_schedule(event.data as SchedulerInput);
    });
    this.eventBus.subscribe('scheduler:call_schedule', (event) => {
      this.call_schedule(event.data as SchedulerInput);
    });
  }

  private async post_schedule(data: SchedulerInput) {
    getWebNotificationHub().emitPostSchedule({
      type: 'post_schedule',
      data: this.schedules,
    } as SchedulerOutput);
  }

  private async call_schedule(data: SchedulerInput) {
    const platform = data.name?.split(':')[0];
    const name = data.name?.split(':')[1];
    logger.info(`Calling schedule: ${platform} ${name}`, 'blue');
    if (platform && name) {
      if (platform === 'twitter' && name === 'check_replies') {
        this.eventBus.publish({
          type: `twitter:check_replies`,
          memoryZone: `twitter:post`,
          data: {
            command: name,
          } as TwitterClientInput,
        });
      } else if (platform === 'twitter') {
        deliverScheduledPostToLlm({
          command: name,
        } as TwitterClientInput);
      } else if (platform === 'youtube' && name === 'check_comments') {
        this.eventBus.publish({
          type: `youtube:check_comments`,
          memoryZone: `youtube`,
          data: {
            command: name,
          } as YoutubeClientInput,
        });
      } else if (platform === 'youtube' && name === 'check_subscribers') {
        this.eventBus.publish({
          type: `youtube:check_subscribers`,
          memoryZone: `youtube`,
          data: {
            command: name,
          } as YoutubeClientInput,
        });
      }
    }
  }

  private async schedule() {
    this.schedules.forEach((schedule) => {
      cron.schedule(schedule.time, () => {
        this.eventBus.publish(schedule.data);
      });
    });
  }
}
