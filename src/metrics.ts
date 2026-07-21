/**
 * Minimal zero-dependency Prometheus metrics (D39, T-18-a).
 *
 * We deliberately avoid adding `prom-client` as a runtime dependency: the metrics
 * this feature needs are a handful of process-local counters/gauges, and the Done
 * gate only requires they be scrapeable from `GET /metrics` in exposition format.
 *
 * CAVEAT: values are process-local and reset on restart. Under multiple pods the
 * scraped sum diverges from the true global count — acceptable for D39 visibility,
 * consistent with the "local per pod" philosophy of D28.
 */

export class Counter {
  private value = 0;

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(n = 1): void {
    this.value += n;
  }

  get(): number {
    return this.value;
  }

  render(): string {
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} counter\n${this.name} ${this.value}`;
  }
}

export class Gauge {
  private value = 0;

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(n = 1): void {
    this.value += n;
  }

  dec(n = 1): void {
    this.value -= n;
  }

  set(v: number): void {
    this.value = v;
  }

  get(): number {
    return this.value;
  }

  render(): string {
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} gauge\n${this.name} ${this.value}`;
  }
}

// --- Feature metrics (D39) ---

/** Inboxes with an active builtin playbook bot (playbook + LLM key present). */
export const activeInboxesGauge = new Gauge(
  'playbook_in_axis_active_inboxes',
  'Number of inboxes with an active builtin playbook bot (playbook + LLM key).',
);

/** Builtin bots auto-created or re-enabled by applyAutoBotForInbox. */
export const botAutoCreatedTotal = new Counter(
  'bot_auto_created_total',
  'Total builtin bots auto-created or re-enabled by applyAutoBotForInbox.',
);

/** Builtin bots auto-disabled by applyAutoBotForInbox. */
export const botAutoDisabledTotal = new Counter(
  'bot_auto_disabled_total',
  'Total builtin bots auto-disabled by applyAutoBotForInbox.',
);

// --- Phase 13 daily-send-cap (R1.5) ---

export const inboxSendCountTotal = new Counter(
  'inbox_send_count_total',
  'Total Gmail sends accounted for the daily-cap counter (across all inboxes).',
);
export const inboxOvercapTotal = new Counter(
  'inbox_overcap_total',
  'Total Gmail send attempts blocked or delayed by the daily cap.',
);
export const inboxPausedTotal = new Counter(
  'inbox_paused_total',
  'Total times an inbox transitioned to paused (cap=0 / needs-reauth / manual).',
);
export const inboxReleaseTotal = new Counter(
  'inbox_release_total',
  'Total slot releases on Gmail inbox-level errors (401/403/429) or cancel.',
);
export const inboxPromoteTotal = new Counter(
  'inbox_promote_total',
  'Total backlog jobs promoted on cap-up or reauth.',
);

const registry: Array<Counter | Gauge> = [
  activeInboxesGauge,
  botAutoCreatedTotal,
  botAutoDisabledTotal,
  inboxSendCountTotal,
  inboxOvercapTotal,
  inboxPausedTotal,
  inboxReleaseTotal,
  inboxPromoteTotal,
];

/** Render all registered metrics in Prometheus text exposition format. */
export function renderMetrics(): string {
  return `${registry.map((m) => m.render()).join('\n\n')}\n`;
}
