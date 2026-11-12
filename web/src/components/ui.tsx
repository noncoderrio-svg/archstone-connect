import { Eye, EyeOff, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import {
  createContext, useContext, useEffect, useId, useState, useCallback,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };

// ---------- Buttons ----------
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'whatsapp';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-white shadow-sm hover:bg-brand-strong dark:text-slate-950',
  secondary: 'bg-surface text-ink border border-line hover:bg-surface-2',
  ghost: 'text-body hover:bg-surface-2',
  danger: 'bg-red-700 text-white hover:bg-red-800',
  whatsapp: 'bg-[#128c4b] text-white hover:bg-[#0e7a40]',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  busy?: boolean;
}

/** The Archstone wordmark. "auto" follows light and dark mode, "light" is for dark backgrounds, "print" always prints dark. */
export function Logo({ variant = 'auto', className }: { variant?: 'auto' | 'light' | 'print'; className?: string }) {
  if (variant === 'light') return <img src="/logo-light.svg" alt="Archstone" className={cx('h-auto', className)} />;
  if (variant === 'print') return <img src="/logo.svg" alt="Archstone" className={cx('h-auto', className)} />;
  return (
    <>
      <img src="/logo.svg" alt="Archstone" className={cx('h-auto dark:hidden', className)} />
      <img src="/logo-light.svg" alt="" aria-hidden="true" className={cx('hidden h-auto dark:block', className)} />
    </>
  );
}

export function Button({ variant = 'secondary', size = 'md', busy, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors whitespace-nowrap disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-[13px] max-sm:h-10 max-sm:px-3' : 'h-10 px-3.5 text-sm max-sm:h-11',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {busy && <LoaderCircle size={15} className="animate-spin" />}
      {children}
    </button>
  );
}

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx('inline-flex size-10 items-center justify-center rounded-lg text-body hover:bg-surface-2', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------- Layout pieces ----------
export const Card = ({ className, children }: { className?: string; children: ReactNode }) => (
  <section className={cx('card rounded-xl border border-line bg-surface', className)}>{children}</section>
);

export function CardHeader({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-2.5">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {hint && <p className="text-[13px] text-muted">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3 max-sm:mb-3 max-sm:gap-2">
      <div className="min-w-0">
        <h1 className="font-display text-[26px] leading-tight font-semibold max-sm:text-[22px]">{title}</h1>
        {subtitle && <p className="mt-0.5 text-muted max-sm:text-[13px]">{subtitle}</p>}
      </div>
      {actions && <div className="scroll-thin flex flex-wrap items-center gap-2 max-sm:-mx-4 max-sm:w-[calc(100%+2rem)] max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:px-4 max-sm:pb-0.5">{actions}</div>}
    </header>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'alert' }) {
  return (
    <Card className={cx('stat px-4 py-3.5', tone === 'alert' && 'stat-alert')}>
      <p className="text-[13px] text-muted">{label}</p>
      <p className={cx('mt-0.5 text-[28px] leading-tight font-semibold tabular-nums', tone === 'alert' ? 'text-red-700 dark:text-red-400' : 'text-ink')}>{value}</p>
      {hint && <p className="text-[13px] text-muted">{hint}</p>}
    </Card>
  );
}

export const Spinner = () => (
  <div className="flex justify-center py-14 text-muted" role="status" aria-label="Loading">
    <LoaderCircle className="animate-spin" />
  </div>
);

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="font-medium text-ink">{title}</p>
      {children && <div className="mt-1 text-muted">{children}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/50 dark:text-red-300">
      <TriangleAlert size={16} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      <TriangleAlert size={16} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

const BADGES = {
  neutral: 'bg-surface-2 text-body border-line',
  brand: 'bg-brand-soft text-brand-ink border-transparent',
  green: 'bg-emerald-50 text-emerald-800 border-transparent dark:bg-emerald-950/50 dark:text-emerald-300',
  amber: 'bg-amber-50 text-amber-900 border-transparent dark:bg-amber-950/50 dark:text-amber-300',
  red: 'bg-red-50 text-red-800 border-transparent dark:bg-red-950/50 dark:text-red-300',
};
export const Badge = ({ tone = 'neutral', children }: { tone?: keyof typeof BADGES; children: ReactNode }) => (
  <span className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', BADGES[tone])}>{children}</span>
);

export const TempBadge = ({ value }: { value: string }) => (
  <Badge tone={value === 'Hot' ? 'red' : value === 'Warm' ? 'amber' : 'neutral'}>{value}</Badge>
);

// ---------- Forms ----------
const FIELD = 'rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted focus:border-brand focus:ring-2 focus:ring-brand/15 focus:outline-none';
const fieldWidth = (className?: string) => (/(^|\s)w-/.test(className ?? '') ? '' : 'w-full');

export function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[13px] font-medium text-body">{label}</label>
      {children(id)}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input className={cx(FIELD, fieldWidth(className), 'h-10', className)} {...p} />;
export const Select = ({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select className={cx(FIELD, fieldWidth(className), 'h-10', className)} {...p}>{children}</select>
);
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea className={cx(FIELD, fieldWidth(className), 'py-2', className)} rows={3} {...p} />;

function PasswordInput({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  const [shown, setShown] = useState(false);
  const label = shown ? 'Hide password' : 'Show password';
  return (
    <div className="relative">
      <Input {...p} type={shown ? 'text' : 'password'} className={cx('pr-11', className)} />
      <button type="button" aria-label={label} title={label} aria-pressed={shown} onClick={() => setShown((v) => !v)}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-muted hover:text-ink">
        {shown ? <EyeOff size={17} /> : <Eye size={17} />}
      </button>
    </div>
  );
}

// API tokens use autoComplete="off" and stay hidden: they are pasted once and never need reading back.
export const TextField = ({ label, hint, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) => (
  <Field label={label} hint={hint}>{(id) => (p.type === 'password' && p.autoComplete !== 'off' ? <PasswordInput id={id} {...p} /> : <Input id={id} {...p} />)}</Field>
);
export const SelectField = ({ label, hint, children, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string }) => (
  <Field label={label} hint={hint}>{(id) => <Select id={id} {...p}>{children}</Select>}</Field>
);
export const TextareaField = ({ label, hint, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string }) => (
  <Field label={label} hint={hint}>{(id) => <Textarea id={id} {...p} />}</Field>
);

// ---------- Modal ----------
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={cx('fade-in scroll-thin max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl', wide ? 'sm:max-w-2xl' : 'sm:max-w-md')}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface px-5 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose} className="-mr-2"><X size={18} /></IconButton>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// ---------- Toasts ----------
type Toast = { id: number; text: string; bad?: boolean };
const ToastCtx = createContext<(text: string, bad?: boolean) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, bad?: boolean) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, bad }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), bad ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed inset-x-3 bottom-20 z-[60] flex flex-col items-center gap-2 lg:bottom-5" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx('fade-in max-w-md rounded-lg px-4 py-2.5 text-sm shadow-lg', t.bad ? 'bg-red-800 text-white' : 'bg-slate-900 text-white')}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Runs an action with a busy flag, showing any failure as a toast. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const out = await fn();
        if (success) toast(success);
        return out;
      } catch (e) {
        toast((e as Error).message, true);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { busy, run };
}
