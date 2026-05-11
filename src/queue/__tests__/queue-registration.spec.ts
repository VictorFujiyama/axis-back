import { describe, expect, it } from 'vitest';

import { QUEUE_NAMES, type QueueName } from '../index';

describe('QUEUE_NAMES — gmail-sync registration', () => {
  it('exposes GMAIL_SYNC as the wire name "gmail-sync"', () => {
    expect(QUEUE_NAMES.GMAIL_SYNC).toBe('gmail-sync');
  });

  // The QueueRegistry constructor iterates `Object.values(QUEUE_NAMES)` and
  // creates a BullMQ Queue for each entry, so membership in this set is what
  // makes a queue "registered" at boot.
  it('includes gmail-sync in the iteration set used by the registry constructor', () => {
    expect(Object.values(QUEUE_NAMES)).toContain('gmail-sync');
  });

  it('keeps every legacy queue name present (no accidental removals)', () => {
    const expected: QueueName[] = [
      'bot-dispatch',
      'email-outbound',
      'whatsapp-outbound',
      'telegram-outbound',
      'instagram-outbound',
      'messenger-outbound',
      'snooze-reopen',
      'scheduled-message',
      'webhook-delivery',
      'campaign-runner',
      'campaign-send',
      'media-mirror',
      'gmail-sync',
      'atlas-events',
    ];
    for (const name of expected) {
      expect(Object.values(QUEUE_NAMES)).toContain(name);
    }
  });
});

describe('QUEUE_NAMES — atlas-events registration', () => {
  it('exposes ATLAS_EVENTS as the wire name "atlas-events"', () => {
    expect(QUEUE_NAMES.ATLAS_EVENTS).toBe('atlas-events');
  });

  it('includes atlas-events in the iteration set used by the registry constructor', () => {
    expect(Object.values(QUEUE_NAMES)).toContain('atlas-events');
  });
});
