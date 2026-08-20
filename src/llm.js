import Anthropic from '@anthropic-ai/sdk';

export const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env
export const MODEL = process.env.CONVOCA_MODEL || 'claude-opus-5';
