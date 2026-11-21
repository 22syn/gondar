import type Anthropic from '@anthropic-ai/sdk';
import { completeText, CLASSIFY_MODEL, type CreateMessage } from '../src/services/claude';

jest.mock('../src/config/index.js', () => ({ config: { anthropicApiKey: '' } }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn() } }));

const REQUEST = { model: CLASSIFY_MODEL, system: 's', prompt: 'p', maxTokens: 100, effort: 'low' } as const;

function reply(content: unknown[], stop_reason = 'end_turn'): Anthropic.Message {
    return { content, stop_reason } as unknown as Anthropic.Message; // test double: only the fields completeText reads
}

describe('completeText', () => {
    it('joins text blocks, skips thinking, and sends effort without sampling params', async () => {
        const create = jest.fn<ReturnType<CreateMessage>, Parameters<CreateMessage>>()
            .mockResolvedValue(reply([{ type: 'thinking', thinking: '' }, { type: 'text', text: ' AAPL: STOCK ' }]));
        await expect(completeText(REQUEST, create)).resolves.toBe('AAPL: STOCK');
        const params = create.mock.calls[0][0];
        expect(params.output_config).toEqual({ effort: 'low' });
        expect(params).not.toHaveProperty('temperature');
        expect(params.model).toBe('claude-haiku-5-5');
    });

    it('returns null on refusal', async () => {
        const create = jest.fn().mockResolvedValue(reply([{ type: 'text', text: 'x' }], 'refusal'));
        await expect(completeText(REQUEST, create)).resolves.toBeNull();
    });

    it('returns null when the API throws', async () => {
        const create = jest.fn().mockRejectedValue(new Error('boom'));
        await expect(completeText(REQUEST, create)).resolves.toBeNull();
    });

    it('returns null without calling the API when no key is configured', async () => {
        await expect(completeText(REQUEST)).resolves.toBeNull();
    });
});
