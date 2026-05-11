import type { FastifyBaseLogger } from 'fastify';
import type Redis from 'ioredis';

export type PlaybookSource = 'atlas-fresh' | 'atlas-cached' | 'atlas-304';

export interface PlaybookFetcherApp {
  redis: Redis;
  log: FastifyBaseLogger;
}

export interface PlaybookFetcherDeps {
  fetchImpl?: typeof fetch;
}

export interface PlaybookFetchResult {
  markdown: string;
  source: PlaybookSource;
  etag: string;
}

export async function fetchPlaybook(
  _inboxId: string,
  _app: PlaybookFetcherApp,
  _deps?: PlaybookFetcherDeps,
): Promise<PlaybookFetchResult | null> {
  return null;
}
