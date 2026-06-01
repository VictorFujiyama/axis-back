import { describe, expect, it } from 'vitest';
import {
  Counter,
  Gauge,
  activeInboxesGauge,
  botAutoCreatedTotal,
  botAutoDisabledTotal,
  renderMetrics,
} from '../metrics';

describe('metrics — Counter', () => {
  it('starts at 0 and increments by 1 / n', () => {
    const c = new Counter('test_total', 'a test counter');
    expect(c.get()).toBe(0);
    c.inc();
    c.inc(2);
    expect(c.get()).toBe(3);
  });

  it('renders exposition format', () => {
    const c = new Counter('test_total', 'a test counter');
    c.inc(5);
    const out = c.render();
    expect(out).toContain('# HELP test_total a test counter');
    expect(out).toContain('# TYPE test_total counter');
    expect(out).toContain('test_total 5');
  });
});

describe('metrics — Gauge', () => {
  it('supports inc / dec / set', () => {
    const g = new Gauge('test_gauge', 'a test gauge');
    g.inc(5);
    g.dec(2);
    expect(g.get()).toBe(3);
    g.set(10);
    expect(g.get()).toBe(10);
  });

  it('renders exposition format with gauge type', () => {
    const g = new Gauge('test_gauge', 'a test gauge');
    expect(g.render()).toContain('# TYPE test_gauge gauge');
  });
});

describe('metrics — renderMetrics', () => {
  it('emits all feature metrics in exposition format', () => {
    const out = renderMetrics();
    expect(out).toMatch(/# HELP playbook_in_axis_active_inboxes/);
    expect(out).toMatch(/# TYPE playbook_in_axis_active_inboxes gauge/);
    expect(out).toMatch(/# TYPE bot_auto_created_total counter/);
    expect(out).toMatch(/# TYPE bot_auto_disabled_total counter/);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('reflects live counter/gauge values', () => {
    const created = botAutoCreatedTotal.get();
    const disabled = botAutoDisabledTotal.get();
    const active = activeInboxesGauge.get();

    botAutoCreatedTotal.inc();
    activeInboxesGauge.inc();
    botAutoDisabledTotal.inc();
    activeInboxesGauge.dec();

    expect(botAutoCreatedTotal.get()).toBe(created + 1);
    expect(botAutoDisabledTotal.get()).toBe(disabled + 1);
    expect(activeInboxesGauge.get()).toBe(active);

    const out = renderMetrics();
    expect(out).toContain(`bot_auto_created_total ${created + 1}`);
  });
});
