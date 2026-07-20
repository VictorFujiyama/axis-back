import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, schema, type DB } from '@blossom/db';
import {
  MARCO_INBOX_NAME,
  loadMarcoPlaybook,
  seedMarcoPlaybook,
  type DbOrTx,
} from '../seed-marco-playbook';

// T-B.2 (fase-3): seed idempotente do playbook Marco. A parte de integração
// roda contra um Postgres real com o schema do axis-back aplicado — aponte
// SEED_TEST_DATABASE_URL pro banco local (docker :5434) pra habilitar:
//   SEED_TEST_DATABASE_URL=postgresql://blossom:blossom_dev@localhost:5434/blossom pnpm vitest run src/scripts/__tests__/seed-marco-playbook.spec.ts
// Cada teste roda dentro de uma transação com rollback — nada persiste.

const DB_URL = process.env.SEED_TEST_DATABASE_URL;

describe('loadMarcoPlaybook', () => {
  it('lê o playbook Marco do disco', () => {
    const content = loadMarcoPlaybook();
    expect(content).toContain('Marco');
    expect(content).toContain('3 horários');
    expect(content.length).toBeGreaterThan(500);
  });
});

describe.skipIf(!DB_URL)('seedMarcoPlaybook (integration)', () => {
  let db: DB;
  let client: ReturnType<typeof createDb>['client'];

  beforeAll(() => {
    ({ db, client } = createDb(DB_URL!));
  });

  afterAll(async () => {
    await client.end();
  });

  class Rollback extends Error {}

  async function withRollback(fn: (tx: DbOrTx) => Promise<void>): Promise<void> {
    await db
      .transaction(async (tx) => {
        await fn(tx);
        throw new Rollback('rollback');
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
  }

  it('primeira rodada cria inbox "Marco Demo" + playbook v1', async () => {
    await withRollback(async (tx) => {
      const content = loadMarcoPlaybook();
      const result = await seedMarcoPlaybook(tx, content);

      expect(result.inboxAction).toBe('created');
      expect(result.playbookAction).toBe('created');
      expect(result.version).toBe(1);

      const [inbox] = await tx
        .select()
        .from(schema.inboxes)
        .where(eq(schema.inboxes.id, result.inboxId))
        .limit(1);
      expect(inbox?.name).toBe(MARCO_INBOX_NAME);
      expect(inbox?.channelType).toBe('api');
      expect(inbox?.accountId).toBeTruthy();

      const [playbook] = await tx
        .select()
        .from(schema.inboxPlaybooks)
        .where(eq(schema.inboxPlaybooks.inboxId, result.inboxId))
        .limit(1);
      expect(playbook?.content).toBe(content);
      expect(playbook?.version).toBe(1);
      expect(playbook?.etag).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  it('segunda rodada é no-op (idempotente)', async () => {
    await withRollback(async (tx) => {
      const content = loadMarcoPlaybook();
      const first = await seedMarcoPlaybook(tx, content);
      const second = await seedMarcoPlaybook(tx, content);

      expect(second.inboxId).toBe(first.inboxId);
      expect(second.inboxAction).toBe('kept');
      expect(second.playbookAction).toBe('unchanged');
      expect(second.version).toBe(1);
    });
  });

  it('conteúdo driftado no banco é restaurado com bump de versão', async () => {
    await withRollback(async (tx) => {
      const content = loadMarcoPlaybook();
      const first = await seedMarcoPlaybook(tx, content);

      await tx
        .update(schema.inboxPlaybooks)
        .set({ content: 'conteúdo editado por fora' })
        .where(eq(schema.inboxPlaybooks.inboxId, first.inboxId));

      const second = await seedMarcoPlaybook(tx, content);
      expect(second.playbookAction).toBe('updated');
      expect(second.version).toBe(2);

      const [playbook] = await tx
        .select()
        .from(schema.inboxPlaybooks)
        .where(eq(schema.inboxPlaybooks.inboxId, first.inboxId))
        .limit(1);
      expect(playbook?.content).toBe(content);
    });
  });

  it('grava snapshot em inbox_playbook_versions quando a tabela existe', async () => {
    await withRollback(async (tx) => {
      // A tabela é criada pela Track A (fase-3.A). Cria aqui dentro da tx
      // (rollback desfaz) pra testar o caminho de insert mesmo antes do merge.
      await tx.execute(sql`
        create table if not exists inbox_playbook_versions (
          id uuid primary key default gen_random_uuid(),
          inbox_id uuid not null references inboxes(id) on delete cascade,
          version integer not null,
          content text not null,
          note text,
          created_by uuid,
          created_at timestamptz not null default now(),
          unique (inbox_id, version)
        )
      `);

      const content = loadMarcoPlaybook();
      const first = await seedMarcoPlaybook(tx, content);
      expect(first.versionAction).toBe('inserted');

      const second = await seedMarcoPlaybook(tx, content);
      expect(second.versionAction).toBe('exists');

      const rows = (await tx.execute(sql`
        select version, note from inbox_playbook_versions
        where inbox_id = ${first.inboxId}
      `)) as unknown as Array<{ version: number; note: string | null }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.version).toBe(1);
      expect(rows[0]?.note).toBe('seed-marco-playbook');
    });
  });

  it('não quebra quando inbox_playbook_versions ainda não existe', async () => {
    await withRollback(async (tx) => {
      const reg = (await tx.execute(
        sql`select to_regclass('public.inbox_playbook_versions') as tbl`,
      )) as unknown as Array<{ tbl: string | null }>;
      const tableExists = reg[0]?.tbl != null;

      const result = await seedMarcoPlaybook(tx, loadMarcoPlaybook());
      if (tableExists) {
        expect(['inserted', 'exists']).toContain(result.versionAction);
      } else {
        expect(result.versionAction).toBe('table-missing');
      }
    });
  });
});
