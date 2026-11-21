/**
 * Claude API access for the radar — the single place that talks to Anthropic.
 *
 * Replaces the Groq (llama-3.3-70b) calls in `llmSummary.ts` (ticker classification) and
 * `scripts/evaluate-retro-advanced.ts` (Hebrew narrative). Callers keep their own prompts
 * and parsing; this returns text, or null when no answer could be obtained (no key, API
 * error, refusal) so every caller degrades exactly as it did with Groq.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

/** Short, rule-bound labelling — the cheapest tier is enough. */
export const CLASSIFY_MODEL = 'claude-haiku-5-5';
/** Free-form Hebrew analysis of backtest numbers — wants judgment. */
export const ANALYSIS_MODEL = 'claude-sonnet-5-5';
const REQUEST_TIMEOUT_MS = 60_000;

export type Effort = 'low' | 'medium' | 'high';

export interface CompletionRequest {
    readonly model: string;
    readonly system: string;
    readonly prompt: string;
    /** Thinking tokens count toward this cap, so leave headroom above the visible answer. */
    readonly maxTokens: number;
    readonly effort: Effort;
}

export type CreateMessage = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;

function createDefaultMessage(): CreateMessage {
    const client = new Anthropic({ apiKey: config.anthropicApiKey, timeout: REQUEST_TIMEOUT_MS });
    return (params) => client.messages.create(params);
}

/**
 * One non-streaming completion. No temperature/top_p: Haiku/Sonnet 5.5 reject non-default
 * sampling parameters with a 400 — `effort` is the depth control instead.
 */
export async function completeText(
    req: CompletionRequest,
    createMessage?: CreateMessage,
): Promise<string | null> {
    if (!createMessage && !config.anthropicApiKey) {
        logger.info('Anthropic API key missing — LLM call skipped');
        return null;
    }
    try {
        const create = createMessage ?? createDefaultMessage();
        const res = await create({
            model: req.model,
            max_tokens: req.maxTokens,
            system: req.system,
            output_config: { effort: req.effort },
            messages: [{ role: 'user', content: req.prompt }],
        });
        if (res.stop_reason === 'refusal') {
            logger.warn('Claude declined this request');
            return null;
        }
        // thinking blocks are not part of the answer — keep text blocks only
        const text = res.content
            .flatMap((block) => (block.type === 'text' ? [block.text] : []))
            .join('')
            .trim();
        return text || null;
    } catch (e) {
        logger.warn(`Claude call failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
}
