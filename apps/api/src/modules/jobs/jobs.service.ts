import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { AppConfig, CONFIG } from '../../config';
import { ChangesService } from '../changes/changes.service';
import { HoldReleaseService } from '../inventory/hold-release.service';
import { WaitlistService } from '../waitlist/waitlist.service';

const QUEUE = 'maintenance';
const RELEASE_HOLDS = 'release-expired-holds';

/**
 * Recurring maintenance on BullMQ. Runs only when REDIS_URL is set; a job scheduler keeps exactly
 * one schedule no matter how many API instances start.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobsService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly holds: HoldReleaseService,
    private readonly waitlist: WaitlistService,
    private readonly changes: ChangesService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.REDIS_URL || this.config.NODE_ENV === 'test') return;
    const connection = { url: this.config.REDIS_URL };
    this.queue = new Queue(QUEUE, { connection });
    await this.queue.upsertJobScheduler(RELEASE_HOLDS, { every: 30_000 }, { name: RELEASE_HOLDS });
    this.worker = new Worker(
      QUEUE,
      async (job) => {
        // Places freed by lapsed checkouts or offers go to the waitlist before anyone else can take them.
        if (job.name === RELEASE_HOLDS) {
          return { released: await this.holds.releaseExpired(), offered: await this.waitlist.offerFreed(), transfersExpired: await this.changes.expireTransfers() };
        }
        return null;
      },
      { connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => this.logger.error(`job ${job?.name} failed: ${err.message}`));
    this.logger.log('maintenance jobs scheduled');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
