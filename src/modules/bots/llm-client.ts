/**
 * Multi-provider LLM client abstraction.
 * Supports OpenAI-compatible APIs and Anthropic Claude.
 */
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config';

const TIMEOUT_MS = config.BOT_LLM_TIMEOUT_MS;

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  provider: 'openai' | 'anthropic';
  model: string;
  apiKey: string;
  systemPrompt: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface LLMResponse {
  content: string;
  usage: { promptTokens: number; completionTokens: number };
  finishReason: string;
}

export async function callLLM(req: LLMRequest): Promise<LLMResponse> {
  if (req.provider === 'openai') {
    return callOpenAI(req);
  }
  if (req.provider === 'anthropic') {
    return callAnthropic(req);
  }
  throw new Error(`Unsupported LLM provider: ${req.provider}`);
}

async function callOpenAI(req: LLMRequest): Promise<LLMResponse> {
  const client = new OpenAI({
    apiKey: req.apiKey,
    timeout: TIMEOUT_MS,
  });

  const completion = await client.chat.completions.create({
    model: req.model,
    messages: [
      { role: 'system', content: req.systemPrompt },
      ...req.messages,
    ],
    temperature: req.temperature ?? 0.7,
    max_tokens: req.maxTokens ?? 1024,
  });

  const choice = completion.choices[0];
  return {
    content: choice?.message?.content ?? '',
    usage: {
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
    },
    finishReason: choice?.finish_reason ?? 'unknown',
  };
}

async function callAnthropic(req: LLMRequest): Promise<LLMResponse> {
  const client = new Anthropic({
    apiKey: req.apiKey,
    timeout: TIMEOUT_MS,
  });

  const response = await client.messages.create({
    model: req.model,
    system: req.systemPrompt,
    messages: req.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    temperature: req.temperature ?? 0.7,
    max_tokens: req.maxTokens ?? 1024,
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  return {
    content: textBlock?.text ?? '',
    usage: {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
    },
    finishReason: response.stop_reason ?? 'unknown',
  };
}

/**
 * Resolve the API key for a bot: per-bot key takes priority over global env var.
 * Returns null if no key is available.
 */
export function resolveApiKey(
  provider: 'openai' | 'anthropic',
  botApiKey?: string | null,
): string | null {
  if (botApiKey && botApiKey.length > 0) return botApiKey;
  if (provider === 'openai') return config.OPENAI_API_KEY ?? null;
  if (provider === 'anthropic') return config.ANTHROPIC_API_KEY ?? null;
  return null;
}
