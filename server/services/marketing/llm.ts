// One door to the AI models for the marketing team. Every answer must fit a schema,
// so an agent can never hand the next agent free text it has to guess at.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { HttpError } from '../../auth.ts';
import { config } from '../../config.ts';

const TIMEOUT_MS = 120_000;

export interface Answer<T> { data: T; provider: 'claude' | 'gemini' | 'simulated'; model: string; simulated: boolean }

/**
 * Which model answers. Claude plans and writes; Gemini researches and analyses. Each stands in
 * for the other when only one key is set. With neither, demo mode shows labelled sample work.
 */
export function brain(prefer: 'claude' | 'gemini' = 'claude'): Answer<unknown>['provider'] | 'none' {
  const has = { claude: Boolean(config.anthropic.key), gemini: Boolean(config.gemini.key) };
  if (has[prefer]) return prefer;
  if (has.claude) return 'claude';
  if (has.gemini) return 'gemini';
  return config.demoMode ? 'simulated' : 'none';
}

async function askClaude<T>(system: string, prompt: string, schema: z.ZodType<T>): Promise<T> {
  const client = new Anthropic({ apiKey: config.anthropic.key, timeout: TIMEOUT_MS, maxRetries: 1 });
  let res;
  try {
    res = await client.messages.parse({
      model: config.anthropic.model,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: prompt }],
      output_config: { format: zodOutputFormat(schema) },
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(502, 'Claude refused the API key. Check it in Settings, Integrations.');
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(502, 'Claude is busy right now. Please try again in a minute.');
    if (e instanceof Anthropic.APIError) throw new HttpError(502, `Claude error: ${e.message.slice(0, 200)}`);
    throw new HttpError(504, 'Claude could not be reached.');
  }
  if (res.stop_reason === 'refusal') throw new HttpError(502, 'Claude declined this request.');
  if (res.stop_reason === 'max_tokens' || !res.parsed_output) throw new HttpError(502, 'Claude returned an incomplete answer.');
  return res.parsed_output as T;
}

async function askGemini<T>(system: string, prompt: string, schema: z.ZodType<T>): Promise<T> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent`;
  const shape = JSON.stringify(z.toJSONSchema(schema));
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: `${prompt}\n\nReply with only one JSON object that fits this JSON Schema:\n${shape}` }] }],
        generationConfig: { temperature: 0.5, maxOutputTokens: 16000, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(504, 'The AI service could not be reached.');
  }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, body?.error?.message ?? 'The AI service did not respond.');
  const text: string = body.candidates?.[0]?.content?.parts?.filter((p: any) => !p.thought).map((p: any) => p.text ?? '').join('') ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^```(json)?|```$/g, '').trim());
  } catch {
    throw new HttpError(502, 'The AI service returned an answer that could not be read.');
  }
  const checked = schema.safeParse(parsed);
  if (!checked.success) throw new HttpError(502, `The AI answer was missing parts: ${checked.error.issues[0]?.path.join('.')}`);
  return checked.data;
}

/**
 * Asks the model for an answer in a fixed shape. `sample` is what demo mode shows
 * when no AI key is set; it is always marked simulated and never used on a live system.
 */
export async function generate<T>(o: { system: string; prompt: string; schema: z.ZodType<T>; sample: () => T; prefer?: 'claude' | 'gemini' }): Promise<Answer<T>> {
  const which = brain(o.prefer);
  if (which === 'claude') return { data: await askClaude(o.system, o.prompt, o.schema), provider: 'claude', model: config.anthropic.model, simulated: false };
  if (which === 'gemini') return { data: await askGemini(o.system, o.prompt, o.schema), provider: 'gemini', model: config.gemini.model, simulated: false };
  if (which === 'simulated') return { data: o.schema.parse(o.sample()), provider: 'simulated', model: 'sample', simulated: true };
  throw new HttpError(503, 'AI is not connected. Add a Claude or Gemini key in Settings, Integrations.');
}
