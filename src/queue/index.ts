import { Queue, Worker, type ConnectionOptions, type Processor } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';

/**
 * BullMQ requires a dedicated Redis connection per Worker (blocking).
 * We share the connection options and create new instances per worker.
 */
function makeConnection(): ConnectionOptions {
  // BullMQ requires maxRetriesPerRequest=null on the connection used by workers.
  // Carry through credentials and TLS from the URL — Upstash and other managed
  // Redis providers reject unauthenticated TCP connections.
  const u = new URL(config.REDIS_URL);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

export const QUEUE_NAMES = {
  BOT_DISPATCH: 'bot-dispatch',
  EMAIL_OUTBOUND: 'email-outbound',
  WHATSAPP_OUTBOUND: 'whatsapp-outbound',
  TELEGRAM_OUTBOUND: 'telegram-outbound',
  INSTAGRAM_OUTBOUND: 'instagram-outbound',
  MESSENGER_OUTBOUND: 'messenger-outbound',
  SNOOZE_REOPEN: 'snooze-reopen',
  SCHEDULED_MESSAGE: 'scheduled-message',
  WEBHOOK_DELIVERY: 'webhook-delivery',
  CAMPAIGN_RUNNER: 'campaign-runner',
  CAMPAIGN_SEND: 'campaign-send',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface BotDispatchJob {
  conversationId: string;
  inboxId: string;
  contactId: string;
  newMessageId: string;
  /** Resolved at enqueue time so the fallback handler can reference it
   *  without an extra DB query. */
  botId: string;
  accountId: string;
}

export interface EmailOutboundJob {
  messageId: string;
  conversationId: string;
  inboxId: string;
  contactEmail: string;
  subject: string;
  text: string;
  inReplyToMessageId: string | null;
}

export interface WebhookDeliveryJob {
  subscriptionId: string;
  event: string;
  /** Pre-serialized payload — keeps signature stable across retries. */
  body: string;
  attempt?: number;
}

export interface CampaignRunnerJob {
  campaignId: string;
}

export interface CampaignSendJob {
  campaignId: string;
  contactId: string;
  messageContent: string;
}

export interface ScheduledMessageJob {
  messageId: string;
  conversationId: string;
}

export interface SnoozeReopenJob {
  conversationId: string;
  /** Epoch ms of the original snoozedUntil — used to detect state changes. */
  scheduledFor: number;
}

export interface TelegramOutboundJob {
  messageId: string;
  conversationId: string;
  inboxId: string;
  chatId: string;
  text: string;
  replyToChannelMsgId: string | null;
}

export interface TwilioMetaOutboundJob {
  messageId: string;
  conversationId: string;
  inboxId: string;
  contactAddress: string;
  text: string;
  mediaUrl: string | null;
}

export interface WhatsAppOutboundJob {
  messageId: string;
  conversationId: string;
  inboxId: string;
  contactPhone: string;
  text: string;
  mediaUrl: string | null;
}

export class QueueRegistry {
  private queues = new Map<string, Queue>();
  private workers: Worker[] = [];

  constructor() {
    for (const name of Object.values(QUEUE_NAMES)) {
      this.queues.set(
        name,
        new Queue(name, {
          connection: makeConnection(),
          defaultJobOptions: {
            attempts: 4,
            backoff: { type: 'exponential', delay: 1_000 },
            removeOnComplete: { age: 3600, count: 1000 },
            removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
          },
        }),
      );
    }
  }

  getQueue<T = unknown>(name: QueueName): Queue<T> {
    const q = this.queues.get(name);
    if (!q) throw new Error(`unknown queue: ${name}`);
    return q as Queue<T>;
  }

  registerWorker<T = unknown>(
    name: QueueName,
    processor: Processor<T>,
    concurrency = 5,
  ): Worker<T> {
    const w = new Worker<T>(name, processor, {
      connection: makeConnection(),
      concurrency,
    });
    this.workers.push(w as unknown as Worker);
    return w;
  }

  async getCounts(name: QueueName) {
    const q = this.getQueue(name);
    return q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
  }

  async retryFailed(name: QueueName): Promise<number> {
    const q = this.getQueue(name);
    const failed = await q.getFailed(0, 999);
    let count = 0;
    for (const job of failed) {
      try {
        await job.retry();
        count++;
      } catch {
        /* skip */
      }
    }
    return count;
  }

  async drainAll(name: QueueName): Promise<void> {
    await this.getQueue(name).drain(true);
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

// Sanity check that ioredis works with our config
export function testRedisConnection(): Promise<string> {
  const c = new IORedis(config.REDIS_URL);
  return c.ping().finally(() => c.quit());
}
