import { Platform, ServiceStatus } from '@shannon/common';
import { emitWebServiceStatus } from '../web/webNotificationHub.js';

export abstract class BaseClient {
  public status: ServiceStatus = 'stopped';

  constructor(private readonly serviceName: Platform) {}

  private async setStatus(newStatus: ServiceStatus) {
    this.status = newStatus;
    emitWebServiceStatus({
      service: this.serviceName,
      status: this.status,
    });
  }

  public abstract initialize(): void | Promise<void>;

  public async start() {
    if (this.status === 'running') return;
    await this.setStatus('running');
    await this.initialize();
  }

  public async stop() {
    if (this.status === 'stopped') return;
    await this.setStatus('stopped');
  }
}
