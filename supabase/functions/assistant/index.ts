// The dashboard's AI helper. The app sends your question with a short summary of your tasks and
// schedule; this passes it to a free model on Cloudflare Workers AI and returns the answer and any
// changes it suggests. Nothing changes here: the app lists the suggestions and you tap Apply.
//
// Secrets (set once, see README): CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and optionally AI_MODEL.
import { admin, caller, cors, json } from '../_shared/server.ts';

const MODEL = Deno.env.get('AI_MODEL') || '@cf/openai/gpt-oss-120b';
const MAX_CONTEXT = 30000; // characters of dashboard summary
const MAX_TURNS = 12;
const MAX_TURN = 4000;

const PROMPT = `You are the planning helper inside a college student's class dashboard. You answer questions about their schedule and workload, estimate how long tasks will take, and suggest changes to their plan.

Rules:
- Use only the dashboard data below. Times are the student's local time in 24-hour HH:MM; dates are YYYY-MM-DD.
- Keep "reply" short: one to three plain, friendly sentences. Use 12-hour times like "5 pm" in the reply.
- Suggest changes only when the student asks for them, or asks for estimates. Each change goes in "actions"; the student reviews them and taps Apply. In the reply, say what you're suggesting, not that it's done.
- Refer to tasks and events by their ids (T3, E1). Never make up an id.
- Something at a set time (gym, errands, practice, a meeting) is an add_event. Work that has to be done by a deadline is an add_task; the planner then finds time for it.
- Don't do coursework: don't write, outline, or edit papers, solve problems, or summarize readings. The student's courses limit AI use. Offer to plan time for the work instead.
- If the request is unclear, ask one short question and return no actions.
- Estimates: judge from the task type, its title and notes, and how much is already done. Give minutes and a short reason. Exams use study plans, not estimates. Asked to estimate in general, cover open tasks due in the next two weeks, mainly those marked "rough default".
- Plan around classes, events, and exams, inside the student's work hours, and never before now.

Answer with only a JSON object, no other text:
{"reply": "...", "actions": [ ... ]}

Actions (leave out optional fields you don't need):
{"type":"estimate","task":"T3","minutes":90,"why":"..."}
{"type":"add_task","title":"...","course":"CS","due":"YYYY-MM-DDTHH:MM","minutes":60}   (course, due, minutes optional)
{"type":"add_event","title":"...","date":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM","weekly":["tue","thu"],"until":"YYYY-MM-DD"}   (weekly, until optional)
{"type":"move_event","event":"E1","date":"YYYY-MM-DD","to_date":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM","every_week":false}   (date = the day it happens now)
{"type":"delete_event","event":"E1","date":"YYYY-MM-DD","every_week":false}
{"type":"plan_work","task":"T3","date":"YYYY-MM-DD","start":"HH:MM","minutes":60}   (start optional: the planner picks a time)
{"type":"move_work","task":"T3","from":"YYYY-MM-DD","to":"YYYY-MM-DD","start":"HH:MM"}   (start optional)
{"type":"skip_work","task":"T3","date":"YYYY-MM-DD"}
{"type":"day_limit","date":"YYYY-MM-DD","minutes":120}   (0 = a day off, null = back to normal)
{"type":"replan"}`;

type Turn = { role: 'user' | 'assistant'; content: string };

function cleanTurns(raw: unknown): Turn[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const turns = raw.slice(-MAX_TURNS).map((m) => ({
    role: (m as Turn)?.role === 'assistant' ? 'assistant' : 'user',
    content: String((m as Turn)?.content ?? '').slice(0, MAX_TURN),
  })) as Turn[];
  return turns[turns.length - 1].role === 'user' && turns[turns.length - 1].content.trim() ? turns : null;
}

/** The first JSON object in the model's text (it sometimes adds a code fence or a sentence). */
function parseAnswer(text: string): { reply: string; actions: unknown[] } {
  const body = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
  const a = body.indexOf('{');
  const b = body.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      const j = JSON.parse(body.slice(a, b + 1));
      if (j && typeof j === 'object') {
        return { reply: String(j.reply ?? '').slice(0, 1500), actions: Array.isArray(j.actions) ? j.actions.slice(0, 30) : [] };
      }
    } catch {
      /* fall through: show the text as it is */
    }
  }
  return { reply: text.trim().slice(0, 1500), actions: [] };
}

class AiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

async function callModel(messages: { role: string; content: string }[]) {
  const account = Deno.env.get('CLOUDFLARE_ACCOUNT_ID');
  const token = Deno.env.get('CLOUDFLARE_API_TOKEN');
  if (!account || !token) throw new AiError('not_set_up', 'The AI helper is not connected yet.');
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`;
  const base = { model: MODEL, messages, max_tokens: 4000, temperature: 0.3 };
  // Ask for a quick answer and pure JSON. If the model doesn't take those options, ask again without them.
  const attempts = [{ ...base, reasoning_effort: 'low', response_format: { type: 'json_object' } }, { ...base, reasoning_effort: 'low' }, base];
  let last = '';
  for (const body of attempts) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok) {
      const j = JSON.parse(text);
      const content = j?.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content.trim()) return { content, usage: j.usage ?? null };
      last = 'The AI sent back an empty answer.';
      continue; // e.g. it spent the whole answer thinking: try the plainer request
    }
    last = text.slice(0, 300);
    if (res.status === 401 || res.status === 403) throw new AiError('bad_token', 'Cloudflare turned down the access token.');
    if (res.status === 429 || /daily free allocation|neurons/i.test(text)) {
      throw new AiError(/daily|allocation|neurons/i.test(text) ? 'daily_limit' : 'busy', 'The free AI allowance is used up for now.');
    }
    if (res.status >= 500) throw new AiError('ai_error', 'Cloudflare had a problem. Try again in a minute.');
    // 400: probably an option this model doesn't take. Try the next, plainer request.
  }
  throw new AiError('ai_error', `The AI didn't answer (${last}).`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'bad_request', message: 'Use POST.' }, 405);
  try {
    const who = await caller(req, admin());
    if (!who) return json({ error: 'signed_out', message: 'Sign in first.' }, 401);
    const body = await req.json().catch(() => null);
    const turns = cleanTurns(body?.messages);
    const context = String(body?.context ?? '').slice(0, MAX_CONTEXT);
    if (!turns || !context) return json({ error: 'bad_request', message: 'Nothing to ask.' }, 400);

    const started = Date.now();
    const { content, usage } = await callModel([
      { role: 'system', content: `${PROMPT}\n\nThe student's dashboard right now:\n${context}` },
      ...turns,
    ]);
    // Log sizes only, never the question or the dashboard data.
    console.log(JSON.stringify({ model: MODEL, ms: Date.now() - started, usage }));
    return json({ ...parseAnswer(content), raw: content.slice(0, 6000), model: MODEL });
  } catch (e) {
    if (e instanceof AiError) return json({ error: e.code, message: e.message }, e.code === 'not_set_up' ? 503 : 502);
    console.error(e);
    return json({ error: 'server', message: (e as Error).message || String(e) }, 500);
  }
});
