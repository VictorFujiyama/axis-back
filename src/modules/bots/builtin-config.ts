import { z } from 'zod';

export const builtinBotConfigSchema = z.object({
  provider: z.enum(['openai', 'anthropic']),
  model: z.string().min(1).max(100),
  systemPrompt: z.string().min(1).max(10_000),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().min(1).max(8192).default(1024),
  /** Where the system prompt comes from: 'inline' (cfg.systemPrompt) or 'atlas' (fetched markdown, falls back to inline on error). */
  playbookSource: z.enum(['inline', 'atlas']).default('inline'),
  /** Words/phrases from the contact that trigger automatic handoff to human. */
  handoffKeywords: z.array(z.string().max(100)).max(50).default([]),
  /** Greeting sent when a conversation first starts with this bot. */
  greetingMessage: z.string().max(2000).optional(),
  /** Safety net: auto-handoff after N bot turns (null = never). */
  maxTurnsBeforeHandoff: z.number().int().min(1).nullable().default(null),
});

export type BuiltinBotConfig = z.infer<typeof builtinBotConfigSchema>;

/** Parse and validate bot.config JSONB for builtin bots. */
export function parseBuiltinConfig(raw: unknown): BuiltinBotConfig {
  return builtinBotConfigSchema.parse(raw);
}
