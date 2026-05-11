import { describe, expect, it } from 'vitest';

import { parseBuiltinConfig } from '../builtin-config';

const baseConfig = {
  provider: 'openai' as const,
  model: 'gpt-4o-mini',
  systemPrompt: 'You are a helpful assistant.',
};

describe('builtinBotConfigSchema — playbookSource', () => {
  it('defaults to "inline" when the field is omitted', () => {
    const parsed = parseBuiltinConfig(baseConfig);
    expect(parsed.playbookSource).toBe('inline');
  });

  it('accepts "inline" explicitly', () => {
    const parsed = parseBuiltinConfig({ ...baseConfig, playbookSource: 'inline' });
    expect(parsed.playbookSource).toBe('inline');
  });

  it('accepts "atlas" explicitly', () => {
    const parsed = parseBuiltinConfig({ ...baseConfig, playbookSource: 'atlas' });
    expect(parsed.playbookSource).toBe('atlas');
  });

  it('rejects an unknown enum value such as "remote"', () => {
    expect(() => parseBuiltinConfig({ ...baseConfig, playbookSource: 'remote' })).toThrow();
  });

  it('preserves other defaults when applying playbookSource default', () => {
    const parsed = parseBuiltinConfig(baseConfig);
    expect(parsed.temperature).toBe(0.7);
    expect(parsed.maxTokens).toBe(1024);
    expect(parsed.handoffKeywords).toEqual([]);
    expect(parsed.maxTurnsBeforeHandoff).toBeNull();
  });
});
