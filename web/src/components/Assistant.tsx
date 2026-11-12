import { Send, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { IconButton, Input, cx } from './ui.tsx';

interface Line { role: 'user' | 'assistant'; text: string }

const SUGGESTIONS = ['What should I do first today?', 'Write a follow-up for a customer who went quiet', 'How do I answer "the price is too high"?'];

/** Opens the assistant from anywhere, optionally with a question ready. */
export const openAssistant = (prompt?: string) => window.dispatchEvent(new CustomEvent('assistant-open', { detail: prompt }));

export function Assistant() {
  const { can, aiEnabled } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const leadId = Number(location.pathname.match(/^\/(?:leads|inbox)\/(\d+)/)?.[1]) || null;

  useEffect(() => {
    const onOpen = (e: Event) => {
      setOpen(true);
      const prompt = (e as CustomEvent).detail;
      if (prompt) setText(prompt);
    };
    window.addEventListener('assistant-open', onOpen);
    return () => window.removeEventListener('assistant-open', onOpen);
  }, []);
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [lines, busy]);

  if (!can('ai.use')) return null;

  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    const history = lines.slice(-8);
    setLines((l) => [...l, { role: 'user', text: question }]);
    setText('');
    setBusy(true);
    try {
      const r = await api.post('/ai/assistant', { question, lead_id: leadId, history });
      setLines((l) => [...l, { role: 'assistant', text: r.text }]);
    } catch (err) {
      setLines((l) => [...l, { role: 'assistant', text: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {!open && (
        <button aria-label="Open AI assistant" onClick={() => setOpen(true)}
          className="fixed right-4 bottom-5 z-30 hidden size-12 items-center justify-center rounded-full bg-brand text-white shadow-lg hover:bg-brand-strong lg:flex dark:text-slate-950">
          <Sparkles size={21} />
        </button>
      )}
      {open && (
        <aside aria-label="AI assistant" className="fade-in fixed inset-x-0 bottom-0 z-50 flex h-[88dvh] flex-col overflow-hidden rounded-t-2xl border border-line bg-surface shadow-2xl sm:right-4 sm:bottom-4 sm:left-auto sm:h-[70dvh] sm:w-96 sm:rounded-2xl">
          <div className="flex items-center gap-2 bg-[#1e293b] px-4 py-2.5 text-white">
            <Sparkles size={17} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Archstone Assistant</p>
              <p className="truncate text-xs text-slate-300">{leadId ? 'Helping with this lead' : 'Sales, follow-ups and WhatsApp wording'}</p>
            </div>
            <IconButton label="Close assistant" onClick={() => setOpen(false)} className="text-white hover:bg-white/10"><X size={18} /></IconButton>
          </div>
          <div className="scroll-thin flex-1 space-y-2 overflow-y-auto p-3">
            {!aiEnabled && <p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">AI is off until your admin adds a Gemini key.</p>}
            {!lines.length && aiEnabled && SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => ask(s)} className="block w-full rounded-lg border border-line px-3 py-2 text-left text-[13px] hover:bg-surface-2">{s}</button>
            ))}
            {lines.map((l, i) => (
              <div key={i} className={cx('flex', l.role === 'user' ? 'justify-end' : 'justify-start')}>
                <p className={cx('max-w-[88%] rounded-xl px-3 py-2 text-sm break-words whitespace-pre-line', l.role === 'user' ? 'bg-brand-soft text-brand-ink' : 'bg-surface-2 text-ink')}>{l.text}</p>
              </div>
            ))}
            {busy && <p className="text-[13px] text-muted">Thinking…</p>}
            <div ref={end} />
          </div>
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); void ask(text); }} className="flex gap-2 border-t border-line p-2">
            <Input aria-label="Ask the assistant" placeholder="Ask anything" value={text} onChange={(e) => setText(e.target.value)} />
            <IconButton label="Send" type="submit" className="bg-brand text-white hover:bg-brand-strong"><Send size={17} /></IconButton>
          </form>
        </aside>
      )}
    </>
  );
}
