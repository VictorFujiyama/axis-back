import { config } from '../../config';

/**
 * Phase 12.2 — MCP pull client (Berg doc Phase 4f, spec §9 / §C.6).
 *
 * The reverse of the push path: axis-back PULLS from Atlas's scoped read-MCP
 * endpoint (`POST ${ATLAS_URL}/api/connectors/atlas-mcp`) so the UI can answer
 * "what does Atlas know about this customer". Auth is a static bearer
 * (`ATLAS_MCP_BEARER`) — NOT the HMAC path. The token maps Atlas-side to the
 * connector row whose `orgId` scopes every tool call (RLS-enforced), so there
 * is no per-request org/sig to compute here.
 *
 * Transport is a minimal JSON-RPC subset (Atlas route.ts speaks `tools/list` +
 * `tools/call` only). We only need `tools/call`. Two of the three tools matter
 * for axis-back v1 — `atlas.search_memory` + `atlas.recent_activity`;
 * `atlas.get_decision` is an Atlas-side v1 stub (returns null), so it has no
 * helper here.
 *
 * Gating (spec §C.6): the helpers throw {@link AtlasMcpError} when
 * `ATLAS_URL`/`ATLAS_MCP_BEARER` are unset. The route that exposes this to the
 * front (T-016) checks {@link isAtlasMcpConfigured} first so it can answer with
 * a clean "not configured" rather than a 500.
 */

const MCP_PATH = '/api/connectors/atlas-mcp';
const TIMEOUT_MS = 10_000;

export interface AtlasMcpClientDeps {
  fetchImpl?: typeof fetch;
}

/**
 * Wire-faithful mirror of Atlas `@atlas/ai` cross-app.ts `DurableHit` /
 * `EpisodicHit`. That package is not vendored into axis-back, so the tier-hit
 * shapes are redeclared here. JSON over the wire turns `Date` columns into ISO
 * strings — hence `occurredAt: string` (not `Date`).
 */
export interface AtlasDurableHit {
  id: string;
  namespace: string;
  key: string;
  content: string;
  etag: string;
  version: number;
  provenance: Record<string, unknown>;
  rrfScore: number;
  keywordRank: number | null;
  semanticRank: number | null;
}

export interface AtlasEpisodicHit {
  id: string;
  app: string;
  kind: string;
  eventId: string;
  summary: string;
  occurredAt: string;
  sourceRef: { id: string; parent_id?: string | null; url?: string | null };
  actors: unknown[];
  participants: unknown[];
  rrfScore: number;
  keywordRank: number | null;
  semanticRank: number | null;
}

/** `atlas.search_memory` result — tier-grouped (spec §9). */
export interface AtlasMemorySearchResult {
  durable: AtlasDurableHit[];
  episodic: AtlasEpisodicHit[];
  /** Atlas session-archive hits (`HybridHit`); opaque to axis-back v1. */
  sessions: unknown[];
}

/** One `memory.events` row returned by `atlas.recent_activity`. */
export interface AtlasRecentActivityRow {
  eventId: string;
  kind: string;
  sourceApp: string;
  sourceRefId: string | null;
  occurredAt: string;
  summary: string | null;
}

export interface AtlasRecentActivityResult {
  rows: AtlasRecentActivityRow[];
}

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

/** Raised for any non-success outcome: unconfigured, network, HTTP, or RPC error. */
export class AtlasMcpError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;
  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = 'AtlasMcpError';
    this.code = code;
    this.data = data;
  }
}

/** True when both the base URL and bearer are present (the route gate, §C.6). */
export function isAtlasMcpConfigured(): boolean {
  return Boolean(config.ATLAS_URL) && Boolean(config.ATLAS_MCP_BEARER);
}

let rpcId = 0;

async function callTool<T>(
  name: string,
  args: Record<string, unknown>,
  deps: AtlasMcpClientDeps,
): Promise<T> {
  const { ATLAS_URL, ATLAS_MCP_BEARER } = config;
  if (!ATLAS_URL || !ATLAS_MCP_BEARER) {
    throw new AtlasMcpError(
      `atlas-mcp ${name}: ATLAS_URL/ATLAS_MCP_BEARER unset (MCP pull disabled)`,
    );
  }

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const url = `${ATLAS_URL.replace(/\/$/, '')}${MCP_PATH}`;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'tools/call',
    params: { name, arguments: args },
  });

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ATLAS_MCP_BEARER}`,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new AtlasMcpError(`atlas-mcp ${name}: network/timeout — ${(err as Error).message}`);
  }

  // The route returns a JSON-RPC body even on 4xx/5xx (auth → 401, parse →
  // 400, internal → 500, tool errors → 200). Parse first so the RPC error
  // message wins over a bare HTTP status. Guard a non-JSON body defensively.
  let json: JsonRpcResponse<T> | undefined;
  try {
    json = (await res.json()) as JsonRpcResponse<T>;
  } catch {
    json = undefined;
  }

  if (json?.error) {
    throw new AtlasMcpError(`atlas-mcp ${name}: ${json.error.message}`, json.error.code, json.error.data);
  }
  if (!res.ok) {
    throw new AtlasMcpError(`atlas-mcp ${name}: HTTP ${res.status}`, res.status);
  }
  if (!json || json.result === undefined) {
    throw new AtlasMcpError(`atlas-mcp ${name}: response missing result`);
  }
  return json.result;
}

/**
 * `atlas.search_memory` — free-text search across Atlas memory tiers, scoped to
 * the bearer's org. `apps` filters by connector slug (e.g. `['messaging']`).
 */
export async function atlasSearchMemory(
  query: string,
  apps?: string[],
  deps: AtlasMcpClientDeps = {},
): Promise<AtlasMemorySearchResult> {
  const args: Record<string, unknown> = { query };
  if (apps && apps.length > 0) args['apps'] = apps;
  return callTool<AtlasMemorySearchResult>('atlas.search_memory', args, deps);
}

/**
 * `atlas.recent_activity` — recent `memory.events` rows for an app in
 * `occurred_at DESC` order. Defaults to the `messaging` connector (axis-back's
 * own app); the tool requires `app`, so it is never omitted on the wire.
 */
export async function atlasRecentActivity(
  app = 'messaging',
  deps: AtlasMcpClientDeps = {},
): Promise<AtlasRecentActivityResult> {
  return callTool<AtlasRecentActivityResult>('atlas.recent_activity', { app }, deps);
}
