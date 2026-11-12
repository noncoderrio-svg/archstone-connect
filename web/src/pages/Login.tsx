import { Download, Share } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Button, ErrorNote, Logo, TextField } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { useInstallApp } from '../lib/install.ts';

/** Installs the site as a phone/desktop app straight from the browser, so no APK download is needed. */
function InstallApp() {
  const { canPrompt, iosHint, install } = useInstallApp();
  if (canPrompt) {
    return (
      <Button variant="ghost" className="mt-3 w-full" onClick={() => void install()}>
        <Download size={16} /> Install the Archstone app
      </Button>
    );
  }
  if (iosHint) {
    return (
      <p className="mt-4 flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-[13px] text-muted">
        <Share size={16} className="mt-0.5 shrink-0" />
        <span>To install on iPhone, tap <b className="text-body">Share</b>, then <b className="text-body">Add to Home Screen</b>.</span>
      </p>
    );
  }
  return null;
}

const TAGLINE = 'Your project, our mandate. We market, sell and deliver every unit, from launch to handover.';

function Skyline() {
  return (
    <svg viewBox="0 0 600 240" className="absolute inset-x-0 bottom-0 w-full text-white/10" aria-hidden="true" preserveAspectRatio="xMidYMax slice">
      <path fill="currentColor" d="M0 240V170h60v-50h70v30h50V70h90v60h50V30h100v110h60v-40h60v60h60v80z" />
      <path fill="currentColor" opacity=".5" d="M0 240v-30h110v-40h80v40h120v-60h90v50h100v-30h100v70z" />
    </svg>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden bg-[#15181e] p-12 text-white lg:flex lg:flex-col lg:justify-center">
        <div className="relative max-w-md">
          <Logo variant="light" className="mb-10 w-72" />
          <p className="text-sm tracking-widest text-[#E86920] uppercase">Real estate mandates</p>
          <p className="mt-4 font-display text-4xl leading-snug">{TAGLINE}</p>
        </div>
        <Skyline />
      </div>
      <main className="flex items-center justify-center bg-surface p-6">
        <div className="fade-in w-full max-w-sm">
          <div className="lg:hidden"><Logo className="mx-auto mb-8 w-72 max-w-full" /></div>
          {children}
        </div>
      </main>
    </div>
  );
}

export function Login() {
  const { refresh, demoMode } = useAuth();
  const [form, setForm] = useState({ email: '', password: '', remember: true });
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.post('/auth/login', needsCode ? { ...form, code } : form);
      if (r.needs_code) setNeedsCode(true);
      else await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <h1 className="text-center font-display text-2xl font-semibold">Archstone Connect</h1>
      <p className="mt-1 mb-6 text-center text-muted">{needsCode ? 'Enter your two-factor code' : 'Sign in to your workspace'}</p>
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorNote>{error}</ErrorNote>}
        {needsCode ? (
          <TextField label="6-digit code or recovery code" hint="From your authenticator app." autoComplete="one-time-code" autoFocus required value={code} onChange={(e) => setCode(e.target.value)} />
        ) : (
          <>
            <TextField label="Email or mobile number" type="text" autoComplete="username" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <TextField label="Password" type="password" autoComplete="current-password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            <label className="flex items-start gap-2 text-sm text-body">
              <input type="checkbox" className="mt-0.5 accent-[var(--brand)]" checked={form.remember} onChange={(e) => setForm({ ...form, remember: e.target.checked })} />
              <span>Remember me<span className="block text-[13px] text-muted">Untick this on a shared computer.</span></span>
            </label>
          </>
        )}
        <Button type="submit" variant="primary" busy={busy} className="w-full">{needsCode ? 'Verify' : 'Sign in'}</Button>
      </form>
      <InstallApp />
      <p className="mt-5 text-center text-[13px] text-muted">
        {demoMode ? 'Demo installation.' : ''} Accounts are created by your administrator.
      </p>
    </Shell>
  );
}

export function ChangePassword() {
  const { refresh, logout, user } = useAuth();
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.next !== form.confirm) return setError('The two new passwords do not match.');
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/password', { current: form.current, next: form.next });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <h1 className="text-center font-display text-2xl font-semibold">Set your password</h1>
      <p className="mt-1 mb-6 text-center text-muted">Welcome, {user?.name}. Choose a private password to continue.</p>
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorNote>{error}</ErrorNote>}
        <TextField label="Temporary password" type="password" autoComplete="current-password" required value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} />
        <TextField label="New password" hint="At least 10 characters." type="password" autoComplete="new-password" required minLength={10} value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} />
        <TextField label="Confirm new password" type="password" autoComplete="new-password" required value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
        <Button type="submit" variant="primary" busy={busy} className="w-full">Save and continue</Button>
        <Button variant="ghost" className="w-full" onClick={logout}>Sign out</Button>
      </form>
    </Shell>
  );
}
