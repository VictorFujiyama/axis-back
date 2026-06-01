import { and, eq } from 'drizzle-orm';
import { type DB, schema } from '@blossom/db';
import { encryptJSON } from '../../crypto';

/**
 * Auto-bot lifecycle for an inbox (D14, D15, D18-D22, D33).
 *
 * A builtin "Atlas Assistant" bot is auto-managed based on whether the inbox has
 * BOTH a playbook (inbox_playbooks row with content) AND an LLM API key + provider.
 * When both are present (and the inbox is not soft-deleted) the bot is created /
 * re-enabled and wired as the inbox's defaultBotId. When either is missing the bot
 * is disabled and defaultBotId cleared — the row is kept for reversibility (D19).
 *
 * This function is the SINGLE writer of inbox.botLlmApiKeyEnc / inbox.botLlmProvider /
 * inbox.defaultBotId and of the builtin bot row, so the PATCH handler (D20) only has
 * to wrap it (plus the playbook upsert) in a transaction.
 */

const BUILTIN_BOT_NAME = 'Atlas Assistant';

const DEFAULT_MODELS: Record<BotProvider, string> = {
  // Validated against llm-client.ts: model string is passed through verbatim (D18).
  anthropic: 'claude-sonnet-4-5-20250929',
  openai: 'gpt-4o',
};

export type BotProvider = 'anthropic' | 'openai';
export type AutoBotReason = 'enable' | 'disable' | 'rotate-key' | 'inbox-deleted';

/** Default model string per provider (D18) — also used for the validateKey smoke ping (D43). */
export function defaultModelFor(provider: BotProvider): string {
  return DEFAULT_MODELS[provider];
}

export interface AutoBotInput {
  inboxId: string;
  accountId: string;
  actorUserId: string;
  reason: AutoBotReason;
  /** undefined = keep current key, null = remove, string = replace (rotate). */
  newApiKey?: string | null;
  newProvider?: BotProvider | null;
}

export interface AutoBotResult {
  action: 'created' | 'updated' | 'disabled' | 'noop';
  botId?: string;
}

/** Both a full DB and a transaction satisfy the query surface we use here. */
export type DbOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

function defaultBuiltinConfig(provider: BotProvider, systemPrompt: string) {
  return {
    provider,
    model: DEFAULT_MODELS[provider],
    systemPrompt,
    temperature: 0.7,
    maxTokens: 1024,
    // 'local' branch lands in T-07; config is plain jsonb so this is safe to set now.
    playbookSource: 'local',
    handoffKeywords: [] as string[],
    maxTurnsBeforeHandoff: null,
  };
}

export async function applyAutoBotForInbox(
  tx: DbOrTx,
  input: AutoBotInput,
): Promise<AutoBotResult> {
  // 1. Load the inbox (carries current key columns + deletedAt).
  const [inbox] = await tx
    .select()
    .from(schema.inboxes)
    .where(eq(schema.inboxes.id, input.inboxId))
    .limit(1);
  if (!inbox) return { action: 'noop' };

  // 2. Resolve the final key/provider state (undefined=keep, null=remove, string=replace).
  const keyProvided = input.newApiKey !== undefined;
  let finalKeyEnc: string | null;
  let finalProvider: BotProvider | null;
  if (!keyProvided) {
    finalKeyEnc = inbox.botLlmApiKeyEnc;
    finalProvider = (inbox.botLlmProvider as BotProvider | null) ?? null;
  } else if (input.newApiKey === null) {
    finalKeyEnc = null;
    finalProvider = null;
  } else {
    finalProvider = input.newProvider ?? (inbox.botLlmProvider as BotProvider | null) ?? null;
    finalKeyEnc = finalProvider
      ? encryptJSON({ apiKey: input.newApiKey, provider: finalProvider })
      : null;
  }

  // 3. Load the playbook for this inbox.
  const [playbook] = await tx
    .select()
    .from(schema.inboxPlaybooks)
    .where(eq(schema.inboxPlaybooks.inboxId, input.inboxId))
    .limit(1);

  const hasPlaybook = !!playbook && playbook.content.trim().length > 0;
  const hasKey = finalKeyEnc != null && finalProvider != null;
  const active = hasPlaybook && hasKey && !inbox.deletedAt;

  // 4. Persist key columns whenever the caller changed them (so rotate/remove stick
  //    even when the inbox ends up inactive). secret column stays encrypted on a plain
  //    disable (D19) — only an explicit key removal clears it.
  if (keyProvided) {
    await tx
      .update(schema.inboxes)
      .set({ botLlmApiKeyEnc: finalKeyEnc, botLlmProvider: finalProvider, updatedAt: new Date() })
      .where(eq(schema.inboxes.id, input.inboxId));
  }

  // 5. Find the managed builtin bot for this inbox.
  const [bot] = await tx
    .select()
    .from(schema.bots)
    .where(
      and(
        eq(schema.bots.inboxId, input.inboxId),
        eq(schema.bots.botType, 'builtin'),
        eq(schema.bots.name, BUILTIN_BOT_NAME),
      ),
    )
    .limit(1);

  const writeAudit = async (action: string, changes: Record<string, unknown>, botId?: string) => {
    await tx.insert(schema.auditLogs).values({
      accountId: input.accountId,
      actorUserId: input.actorUserId,
      action,
      entityType: 'bot',
      entityId: botId ?? null,
      changes: { inboxId: input.inboxId, reason: input.reason, ...changes },
    });
  };

  if (active) {
    if (!bot) {
      const [created] = await tx
        .insert(schema.bots)
        .values({
          accountId: input.accountId,
          name: BUILTIN_BOT_NAME,
          botType: 'builtin',
          // finalKeyEnc is the encryptJSON({apiKey, provider}) blob (D16) — reused as bot.secret.
          secret: finalKeyEnc as string,
          config: defaultBuiltinConfig(finalProvider as BotProvider, playbook!.content),
          inboxId: input.inboxId,
          enabled: true,
        })
        .returning();
      await tx
        .update(schema.inboxes)
        .set({ defaultBotId: created!.id, updatedAt: new Date() })
        .where(eq(schema.inboxes.id, input.inboxId));
      await writeAudit('bot.auto_created', { provider: finalProvider }, created!.id);
      return { action: 'created', botId: created!.id };
    }

    // Bot exists. A real key change rotates the secret (D22).
    if (keyProvided && input.newApiKey !== null) {
      await tx
        .update(schema.bots)
        .set({ enabled: true, secret: finalKeyEnc as string, updatedAt: new Date() })
        .where(eq(schema.bots.id, bot.id));
      await tx
        .update(schema.inboxes)
        .set({ defaultBotId: bot.id, updatedAt: new Date() })
        .where(eq(schema.inboxes.id, input.inboxId));
      await writeAudit('bot.key_rotated', { provider: finalProvider }, bot.id);
      return { action: 'updated', botId: bot.id };
    }

    // No key change. Re-enable a previously disabled bot (reversible flow, D19).
    if (!bot.enabled) {
      await tx
        .update(schema.bots)
        .set({ enabled: true, updatedAt: new Date() })
        .where(eq(schema.bots.id, bot.id));
      await tx
        .update(schema.inboxes)
        .set({ defaultBotId: bot.id, updatedAt: new Date() })
        .where(eq(schema.inboxes.id, input.inboxId));
      await writeAudit('bot.auto_created', { reEnabled: true }, bot.id);
      return { action: 'updated', botId: bot.id };
    }

    return { action: 'noop', botId: bot.id };
  }

  // Inactive: disable the bot if it's currently enabled (D19/D33).
  if (bot && bot.enabled) {
    await tx
      .update(schema.bots)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(schema.bots.id, bot.id));
    await tx
      .update(schema.inboxes)
      .set({ defaultBotId: null, updatedAt: new Date() })
      .where(eq(schema.inboxes.id, input.inboxId));
    await writeAudit('bot.auto_disabled', {}, bot.id);
    return { action: 'disabled', botId: bot.id };
  }

  return { action: 'noop', botId: bot?.id };
}
