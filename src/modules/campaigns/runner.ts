import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema } from '@blossom/db';
import { eventBus } from '../../realtime/event-bus';
import {
  QUEUE_NAMES,
  type CampaignRunnerJob,
  type CampaignSendJob,
} from '../../queue';
import { renderCampaignTemplate } from './merge-tags';

/** Per-channel throttle (messages per second). WhatsApp Twilio tier 1 ≈ 80/s;
 * email 50/s typical. Conservative defaults — tune via inbox.config.campaign.rps. */
const DEFAULT_RPS: Record<string, number> = {
  whatsapp: 30,
  instagram: 30,
  messenger: 30,
  telegram: 25,
  email: 20,
  webchat: 30,
  api: 30,
  sms: 10,
};

export function registerCampaignWorkers(app: FastifyInstance): void {
  // Runner: takes a campaign id, resolves recipients, enqueues sends with staggered delay.
  app.queues.registerWorker<CampaignRunnerJob>(
    QUEUE_NAMES.CAMPAIGN_RUNNER,
    async (job) => {
      const { campaignId } = job.data;
      const [campaign] = await app.db
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaignId))
        .limit(1);
      if (!campaign || campaign.status === 'completed' || campaign.status === 'cancelled') return;

      await app.db
        .update(schema.campaigns)
        .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.campaigns.id, campaignId));

      // Inbox channel determines throttle and identity lookup.
      const [inbox] = await app.db
        .select({ channelType: schema.inboxes.channelType })
        .from(schema.inboxes)
        .where(eq(schema.inboxes.id, campaign.inboxId))
        .limit(1);
      if (!inbox) {
        await markFailed(app, campaignId, 'inbox not found');
        return;
      }

      const tagIds = Array.isArray(campaign.tagIds) ? (campaign.tagIds as string[]) : [];
      if (tagIds.length === 0) {
        await markFailed(app, campaignId, 'no tags selected');
        return;
      }

      // Find contacts with ANY matching tag AND a contact_identity on this inbox's channel.
      const recipients = await app.db
        .selectDistinct({
          id: schema.contacts.id,
          name: schema.contacts.name,
          email: schema.contacts.email,
          phone: schema.contacts.phone,
        })
        .from(schema.contacts)
        .innerJoin(
          schema.contactTags,
          eq(schema.contactTags.contactId, schema.contacts.id),
        )
        .innerJoin(
          schema.contactIdentities,
          eq(schema.contactIdentities.contactId, schema.contacts.id),
        )
        .where(
          and(
            inArray(schema.contactTags.tagId, tagIds),
            eq(schema.contactIdentities.channel, inbox.channelType),
            isNull(schema.contacts.blocked),
            isNull(schema.contacts.deletedAt),
          ),
        );

      if (recipients.length === 0) {
        await app.db
          .update(schema.campaigns)
          .set({
            status: 'completed',
            completedAt: new Date(),
            recipientCount: 0,
            updatedAt: new Date(),
          })
          .where(eq(schema.campaigns.id, campaignId));
        return;
      }

      // Persist recipients upfront so reports can count accurately even if runner crashes.
      await app.db
        .insert(schema.campaignRecipients)
        .values(
          recipients.map((r) => ({ campaignId, contactId: r.id, status: 'pending' as const })),
        )
        .onConflictDoNothing();

      await app.db
        .update(schema.campaigns)
        .set({ recipientCount: recipients.length, updatedAt: new Date() })
        .where(eq(schema.campaigns.id, campaignId));

      const rps = DEFAULT_RPS[inbox.channelType] ?? 20;
      const gapMs = Math.ceil(1000 / rps);
      const sendQueue = app.queues.getQueue<CampaignSendJob>(QUEUE_NAMES.CAMPAIGN_SEND);
      const t0 = Date.now();

      const jobs = recipients.map((r, idx) => ({
        name: 'send' as const,
        data: {
          campaignId,
          contactId: r.id,
          messageContent: renderCampaignTemplate(campaign.template, {
            contact: { name: r.name, email: r.email, phone: r.phone },
          }),
        },
        opts: {
          jobId: `camp-${campaignId}-${r.id}`,
          delay: idx * gapMs,
        },
      }));
      await sendQueue.addBulk(jobs);

      app.log.info(
        { campaignId, recipients: recipients.length, rps, firstAt: t0, lastAt: t0 + jobs.length * gapMs },
        'campaign: runner scheduled sends',
      );
    },
    2,
  );

  // Per-recipient send. Writes an outbound message via the normal path so the
  // channel adapter handles signing/retry. Updates the campaign_recipients row.
  app.queues.registerWorker<CampaignSendJob>(
    QUEUE_NAMES.CAMPAIGN_SEND,
    async (job) => {
      const { campaignId, contactId, messageContent } = job.data;
      const [campaign] = await app.db
        .select({
          inboxId: schema.campaigns.inboxId,
          status: schema.campaigns.status,
        })
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaignId))
        .limit(1);
      if (!campaign || campaign.status === 'cancelled') {
        app.log.debug({ campaignId }, 'campaign: cancelled, skip send');
        return;
      }
      const [existing] = await app.db
        .select({ status: schema.campaignRecipients.status })
        .from(schema.campaignRecipients)
        .where(
          and(
            eq(schema.campaignRecipients.campaignId, campaignId),
            eq(schema.campaignRecipients.contactId, contactId),
          ),
        )
        .limit(1);
      if (existing && existing.status !== 'pending') return;

      // Find or create a conversation for this contact on this inbox.
      let conversationId: string;
      const [existingConv] = await app.db
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(
          and(
            eq(schema.conversations.contactId, contactId),
            eq(schema.conversations.inboxId, campaign.inboxId),
            isNull(schema.conversations.deletedAt),
          ),
        )
        .orderBy(sql`${schema.conversations.updatedAt} DESC`)
        .limit(1);
      if (existingConv) {
        conversationId = existingConv.id;
      } else {
        const [newConv] = await app.db
          .insert(schema.conversations)
          .values({
            contactId,
            inboxId: campaign.inboxId,
            status: 'open',
            lastMessageAt: new Date(),
          })
          .returning({ id: schema.conversations.id });
        if (!newConv) throw new Error('failed to create conversation for campaign');
        conversationId = newConv.id;
      }

      // Insert message, record on recipient.
      const [msg] = await app.db
        .insert(schema.messages)
        .values({
          conversationId,
          inboxId: campaign.inboxId,
          senderType: 'system',
          content: messageContent,
          contentType: 'text',
          metadata: { campaignId },
        })
        .returning({ id: schema.messages.id });
      if (!msg) throw new Error('failed to insert campaign message');

      await app.db
        .update(schema.campaignRecipients)
        .set({ status: 'sent', messageId: msg.id, sentAt: new Date() })
        .where(
          and(
            eq(schema.campaignRecipients.campaignId, campaignId),
            eq(schema.campaignRecipients.contactId, contactId),
          ),
        );

      eventBus.emitEvent({
        type: 'message.created',
        inboxId: campaign.inboxId,
        conversationId,
        message: {
          id: msg.id,
          conversationId,
          inboxId: campaign.inboxId,
          senderType: 'system',
          senderId: null,
          content: messageContent,
          contentType: 'text',
          isPrivateNote: false,
          createdAt: new Date(),
        },
      } as unknown as Parameters<typeof eventBus.emitEvent>[0]);

      // Fire actual channel dispatch (email/whatsapp/etc worker picks it up).
      const { dispatchOutbound } = await import('../messages/routes');
      await dispatchOutbound(app, conversationId, msg.id);
    },
    10,
  );
}

async function markFailed(app: FastifyInstance, campaignId: string, reason: string): Promise<void> {
  await app.db
    .update(schema.campaigns)
    .set({ status: 'failed', completedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.campaigns.id, campaignId));
  app.log.warn({ campaignId, reason }, 'campaign: failed');
}
