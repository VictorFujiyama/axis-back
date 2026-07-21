/**
 * Bot config endpoints — substituem os antigos inbox-playbooks REST.
 * `bots.config` guarda os valores atuais; cada PATCH appenda uma row em
 * `bots_config_versions` (histórico linear, mesmo desenho do playbook antigo).
 * Task 8 adiciona listagem de versões + rollback.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { sha256 } from '../../crypto';
import { writeAudit } from '../../lib/audit';
import { builtinBotConfigSchema, type BuiltinBotConfig } from './builtin-config';

const botIdParams = z.object({ botId: z.string().uuid() });

const patchBody = z
  .object({
    systemPrompt: z.string().min(1).max(10_000).optional(),
    model: z.string().min(1).max(100).optional(),
    provider: z.enum(['openai', 'anthropic']).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(8192).optional(),
    // Optimistic lock: etag que o cliente carregou. Quando presente e
    // divergente do estado atual → 409, ninguém sobrescreve edição alheia.
    expectedEtag: z.string().optional(),
  })
  .refine(
    (v) =>
      v.systemPrompt !== undefined ||
      v.model !== undefined ||
      v.provider !== undefined ||
      v.temperature !== undefined ||
      v.maxTokens !== undefined,
    { message: 'nenhum campo de config para atualizar' },
  );

type ConfigFields = Pick<
  BuiltinBotConfig,
  'systemPrompt' | 'model' | 'provider' | 'temperature' | 'maxTokens'
>;

/** Etag determinístico sobre os campos editáveis (ordem fixa). Mesmo shape do
 * playbook antigo: sha256 truncado em 16 chars. */
export function configEtag(cfg: Partial<ConfigFields>): string {
  return sha256(
    JSON.stringify([cfg.systemPrompt, cfg.model, cfg.provider, cfg.temperature, cfg.maxTokens]),
  ).slice(0, 16);
}

class HttpConflict extends Error {}

const CONFLICT_MSG = 'Config was modified by someone else. Reload and retry.';

export async function botConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/bots/:botId/config',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { botId } = botIdParams.parse(req.params);
      const [bot] = await app.db
        .select()
        .from(schema.bots)
        .where(and(eq(schema.bots.id, botId), eq(schema.bots.accountId, req.user.accountId)))
        .limit(1);
      if (!bot) return reply.notFound();
      if (bot.botType !== 'builtin') return reply.badRequest('bot não é builtin');

      const cfg = bot.config as Partial<BuiltinBotConfig>;
      const [latest] = await app.db
        .select({ version: schema.botsConfigVersions.version })
        .from(schema.botsConfigVersions)
        .where(eq(schema.botsConfigVersions.botId, botId))
        .orderBy(desc(schema.botsConfigVersions.version))
        .limit(1);

      return {
        systemPrompt: cfg.systemPrompt,
        model: cfg.model,
        provider: cfg.provider,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
        etag: configEtag(cfg),
        version: latest?.version ?? 0,
      };
    },
  );

  app.patch(
    '/api/v1/bots/:botId/config',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { botId } = botIdParams.parse(req.params);
      const parsed = patchBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
      }
      const { expectedEtag, ...patch } = parsed.data;

      let newVersion = 0;
      let newEtag = '';
      try {
        await app.db.transaction(async (tx) => {
          // Lock na row do bot serializa saves concorrentes; o perdedor relê o
          // estado pós-commit e falha no check de etag abaixo.
          const [bot] = await tx
            .select()
            .from(schema.bots)
            .where(and(eq(schema.bots.id, botId), eq(schema.bots.accountId, req.user.accountId)))
            .limit(1)
            .for('update');
          if (!bot) throw new NotFoundInTx();
          if (bot.botType !== 'builtin') throw new NotBuiltinInTx();

          const currentCfg = bot.config as Partial<BuiltinBotConfig>;
          if (expectedEtag !== undefined && expectedEtag !== configEtag(currentCfg)) {
            throw new HttpConflict();
          }

          let merged: BuiltinBotConfig;
          try {
            merged = builtinBotConfigSchema.parse({ ...currentCfg, ...patch });
          } catch (err) {
            throw new BadConfigInTx(err instanceof Error ? err.message : 'config inválida');
          }
          newEtag = configEtag(merged);

          const [latest] = await tx
            .select({ version: schema.botsConfigVersions.version })
            .from(schema.botsConfigVersions)
            .where(eq(schema.botsConfigVersions.botId, botId))
            .orderBy(desc(schema.botsConfigVersions.version))
            .limit(1);
          newVersion = (latest?.version ?? 0) + 1;

          await tx.insert(schema.botsConfigVersions).values({
            botId,
            version: newVersion,
            systemPrompt: merged.systemPrompt,
            model: merged.model,
            provider: merged.provider,
            temperature: String(merged.temperature),
            maxTokens: merged.maxTokens,
            etag: newEtag,
            createdByUserId: req.user.sub,
          });

          await tx
            .update(schema.bots)
            .set({ config: merged, updatedAt: new Date() })
            .where(eq(schema.bots.id, botId));
        });
      } catch (err) {
        if (err instanceof NotFoundInTx) return reply.notFound();
        if (err instanceof NotBuiltinInTx) return reply.badRequest('bot não é builtin');
        if (err instanceof BadConfigInTx) return reply.badRequest(`Configuração inválida: ${err.message}`);
        if (err instanceof HttpConflict) return reply.conflict(CONFLICT_MSG);
        // Unique (bot_id, version) violation = writer concorrente venceu a
        // corrida fora do lock path — mesmo remédio de um etag stale.
        if ((err as { code?: string }).code === '23505') return reply.conflict(CONFLICT_MSG);
        throw err;
      }

      void writeAudit(
        req,
        {
          action: 'bot.config_updated',
          entityType: 'bot',
          entityId: botId,
          changes: { version: newVersion, fields: Object.keys(patch) },
        },
        { db: app.db, log: app.log },
      );

      return { etag: newEtag, version: newVersion };
    },
  );

  // No-op: o cache do prompt vive no lado do Atlas (Task 12). O endpoint
  // existe pra front/MCP terem um contrato estável desde já.
  app.post(
    '/api/v1/bots/:botId/invalidate-cache',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { botId } = botIdParams.parse(req.params);
      const [bot] = await app.db
        .select({ id: schema.bots.id })
        .from(schema.bots)
        .where(and(eq(schema.bots.id, botId), eq(schema.bots.accountId, req.user.accountId)))
        .limit(1);
      if (!bot) return reply.notFound();
      return reply.code(200).send({ ok: true });
    },
  );
}

class NotFoundInTx extends Error {}
class NotBuiltinInTx extends Error {}
class BadConfigInTx extends Error {}
