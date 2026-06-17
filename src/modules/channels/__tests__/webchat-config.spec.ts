import { describe, expect, it } from 'vitest';
import { publicWidgetSettings, webchatConfig } from '../webchat-config';

// T-13: appearance fields (spec §3) resolve to backward-compat defaults and
// normalize themeMode/bubblePosition, and /session exposes them all.

describe('webchatConfig appearance defaults', () => {
  it('applies null/auto defaults when config is empty', () => {
    const c = webchatConfig({});
    expect(c.backgroundColor).toBeNull();
    expect(c.agentBubbleColor).toBeNull();
    expect(c.bubbleColor).toBeNull();
    expect(c.headerTitle).toBeNull();
    expect(c.headerSubtitle).toBeNull();
    expect(c.themeMode).toBe('light');
    expect(c.bubblePosition).toBe('right');
    expect(c.launcherLabel).toBe('');
    expect(c.showAvatar).toBe(false);
    expect(c.avatarUrl).toBe('');
  });

  it('normalizes themeMode and bubblePosition to valid values', () => {
    expect(webchatConfig({ themeMode: 'dark' }).themeMode).toBe('dark');
    expect(webchatConfig({ themeMode: 'bogus' }).themeMode).toBe('light');
    expect(webchatConfig({ bubblePosition: 'left' }).bubblePosition).toBe('left');
    expect(webchatConfig({ bubblePosition: 'middle' }).bubblePosition).toBe('right');
  });

  it('keeps explicit appearance values', () => {
    const c = webchatConfig({
      backgroundColor: '#18181b',
      agentBubbleColor: '#27272a',
      bubbleColor: '#ff0000',
      launcherLabel: 'Fale conosco',
      headerTitle: 'Suporte',
      headerSubtitle: 'Online',
      showAvatar: true,
      avatarUrl: 'https://example.com/a.png',
    });
    expect(c.backgroundColor).toBe('#18181b');
    expect(c.agentBubbleColor).toBe('#27272a');
    expect(c.bubbleColor).toBe('#ff0000');
    expect(c.launcherLabel).toBe('Fale conosco');
    expect(c.headerTitle).toBe('Suporte');
    expect(c.headerSubtitle).toBe('Online');
    expect(c.showAvatar).toBe(true);
    expect(c.avatarUrl).toBe('https://example.com/a.png');
  });

  it('exposes every appearance field through publicWidgetSettings', () => {
    const settings = publicWidgetSettings(webchatConfig({ themeMode: 'dark' }));
    expect(settings).toMatchObject({
      backgroundColor: null,
      agentBubbleColor: null,
      themeMode: 'dark',
      bubbleColor: null,
      bubblePosition: 'right',
      launcherLabel: '',
      headerTitle: null,
      headerSubtitle: null,
      showAvatar: false,
      avatarUrl: '',
    });
  });
});
