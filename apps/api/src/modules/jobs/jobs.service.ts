import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { bullOptions } from '../../common/bullmq';
import { AppConfig, CONFIG } from '../../config';
import { ChangesService } from '../changes/changes.service';
import { HoldReleaseService } from '../inventory/hold-release.service';
import { RetentionService } from '../retention/retention.service';
import { WaitingRoomService } from '../waiting-room/waiting-room.service';
import { WaitlistService } from '../waitlist/waitlist.service';

const QUEUE = 'maintenance';
const RELEASE_HOLDS = 'release-expired-holds';
const ADMIT_QUEUES = 'admit-waiting-rooms';
/** Its own queue, so a long retention run never holds up releasing checkouts on `maintenance`. */
const RETENTION_QUEUE = 'data-retention';
const RETENTION = 'erase-expired-personal-data';

/**
 * Recurring maintenance on BullMQ. Runs only when REDIS_URL is set; a job scheduler keeps exactly
 * one schedule no matter how many API instances start.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobsService.name);
  private queue?: Queue;
  private worker?: Worker;
  private retentionQueue?: Queue;
  private retentionWorker?: Worker;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly holds: HoldReleaseService,
    private readonly waitlist: WaitlistService,
    private readonly changes: ChangesService,
    private readonly waitingRoom: WaitingRoomService,
    private readonly retention: RetentionService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.REDIS_URL || this.config.NODE_ENV === 'test') return;
    const bull = bullOptions(this.config);
    this.queue = new Queue(QUEUE, bull);
    await this.queue.upsertJobScheduler(RELEASE_HOLDS, { every: 30_000 }, { name: RELEASE_HOLDS });
    // Cheap when no event has a queue: one SMEMBERS on an empty set.
    await this.queue.upsertJobScheduler(ADMIT_QUEUES, { every: this.config.WAITING_ROOM_TICK_SECONDS * 1000 }, { name: ADMIT_QUEUES });
    this.worker = new Worker(
      QUEUE,
      async (job) => {
        // Places freed by lapsed checkouts or offers go to the waitlist before anyone else can take them.
        if (job.name === RELEASE_HOLDS) {
          return { released: await this.holds.releaseExpired(), offered: await this.waitlist.offerFreed(), transfersExpired: await this.changes.expireTransfers() };
        }
        if (job.name === ADMIT_QUEUES) return { admitted: await this.waitingRoom.admitDue() };
        return null;
      },
      { ...bull, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => this.logger.error(`job ${job?.name} failed: ${err.message}`));

    // Once a night, Thai time: erases personal data past its retention period.
    this.retentionQueue = new Queue(RETENTION_QUEUE, bull);
    await this.retentionQueue.upsertJobScheduler(RETENTION, { pattern: this.config.RETENTION_SCHEDULE, tz: 'Asia/Bangkok' }, { name: RETENTION });
    this.retentionWorker = new Worker(RETENTION_QUEUE, async () => this.retention.run(), { ...bull, concurrency: 1 });
    this.retentionWorker.on('failed', (job, err) => this.logger.error(`job ${job?.name} failed: ${err.message}`));
    this.logger.log('maintenance jobs scheduled');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    await this.retentionWorker?.close();
    await this.retentionQueue?.close();
  }
}
