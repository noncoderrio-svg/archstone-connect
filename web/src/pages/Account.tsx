import { Bell, BellRing, CalendarDays, KeyRound, ShieldCheck } from 'lucide-react';
import { ALERT_KINDS } from '../../../shared/domain.ts';
import { setSound, soundOn } from '../lib/alerts.ts';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ROLE_LABELS } from '../../../shared/domain.ts';
import { Page } from '../components/Layout.tsx';
import { Badge, Button, Card, ErrorNote, Modal, Notice, PageHeader, Spinner, TextField, useAction, useToast } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { inAndroidApp, registerDevice } from '../lib/device.ts';
import { enableWebPush, webPushSupported } from '../lib/install.ts';
import { dateTime } from '../lib/format.ts';

function Section({ icon, title, hint, status, children }: { icon: ReactNode; title: string; hint: string; status?: ReactNode; children?: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand-ink">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-[15px] font-semibold">{title}</h2>{status}</div>
          <p className="text-sm text-muted">{hint}</p>
          {children && <div className="mt-3">{children}</div>}
        </div>
      </div>
    </Card>
  );
}

/** Used on the account page, and as a forced step for admins on a live system. */
export function TwoFactorSetup({ onDone }: { onDone: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[]>([]);
  const { busy, run } = useAction();
  const toast = useToast();

  const start = async () => setSetup((await run(() => api.post('/account/2fa/start'))) ?? null);
  const enable = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post('/account/2fa/enable', { code }));
    if (r) setRecovery(r.recovery_codes);
  };

  if (recovery.length) {
    return (
      <div className="space-y-3">
        <Notice>Save these recovery codes somewhere private. Each works once if you lose your phone. They will not be shown again.</Notice>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface-2 p-3 font-mono text-sm text-ink">{recovery.map((c) => <span key={c}>{c}</span>)}</div>
        <div className="flex gap-2">
          <Button onClick={async () => { await navigator.clipboard.writeText(recovery.join('\n')); toast('Copied'); }}>Copy</Button>
          <Button variant="primary" onClick={onDone}>I have saved them</Button>
        </div>
      </div>
    );
  }
  if (!setup) return <Button variant="primary" busy={busy} onClick={start}>Set up two-factor login</Button>;
  return (
    <form onSubmit={enable} className="space-y-3">
      <p className="text-sm">Scan this with Google Authenticator or a similar app, then enter the 6-digit code it shows.</p>
      <img src={setup.qr} alt="Two-factor QR code" width={180} height={180} className="rounded-lg border border-line bg-white" />
      <p className="text-xs break-all text-muted">Or enter this key: {setup.secret}</p>
      <TextField label="6-digit code" inputMode="numeric" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} />
      <Button type="submit" variant="primary" busy={busy}>Turn on</Button>
    </form>
  );
}

function AlertChoices({ prefs, hasPhone }: { prefs: { push: Record<string, boolean>; whatsapp: Record<string, boolean> }; hasPhone: boolean }) {
  const [f, setF] = useState(prefs);
  const [sound, setSoundState] = useState(soundOn());
  const { busy, run } = useAction();
  const toast = useToast();
  const flip = (channel: 'push' | 'whatsapp', key: string, on: boolean) => setF((s) => ({ ...s, [channel]: { ...s[channel], [key]: on } }));
  const sendTest = async () => {
    const r = await run(() => api.post('/account/alerts/test'));
    if (!r) return;
    const web = r.phone.web ?? { devices: 0, sent: 0, error: '' };
    const appSent = r.firebase_ready && r.phone.sent > 0;
    if (web.sent || appSent) toast(`Sent to ${web.sent + (appSent ? r.phone.sent : 0)} of your devices. It should appear in a few seconds.`);
    else if (web.devices) toast(`The notification could not be delivered. ${web.error}`, true);
    else if (r.firebase_ready && r.phone.devices) toast(`The phone alert failed. ${r.phone.error}`, true);
    else toast('Test is in the bell, but notifications are not on for any of your devices. Use "Turn on for this device" under Phone notifications.', true);
  };
  return (
    <Section icon={<BellRing size={20} />} title="My alerts" hint="Choose how you hear about new leads and follow-ups. Your administrator sets quiet hours and reminder timing.">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-[13px] text-muted"><th className="py-1 font-medium">Alert</th><th className="px-2 py-1 text-center font-medium">Phone</th><th className="px-2 py-1 text-center font-medium">WhatsApp</th></tr></thead>
        <tbody className="divide-y divide-line">
          {ALERT_KINDS.map((k) => (
            <tr key={k.key}>
              <td className="py-1.5">{k.label}</td>
              <td className="px-2 text-center"><input type="checkbox" aria-label={`${k.label} on phone`} className="accent-[var(--brand)]" checked={f.push[k.key] !== false} onChange={(e) => flip('push', k.key, e.target.checked)} /></td>
              <td className="px-2 text-center"><input type="checkbox" aria-label={`${k.label} on WhatsApp`} className="accent-[var(--brand)]" disabled={k.key === 'team'} checked={k.key !== 'team' && f.whatsapp[k.key] !== false} onChange={(e) => flip('whatsapp', k.key, e.target.checked)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {!hasPhone && <p className="mt-1 text-[13px] text-muted">Ask your administrator to add your mobile number to get WhatsApp alerts.</p>}
      <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[var(--brand)]" checked={sound} onChange={(e) => { setSound(e.target.checked); setSoundState(e.target.checked); }} />Play a sound with pop-up alerts on this device</label>
      <div className="mt-3 flex gap-2">
        <Button variant="primary" busy={busy} onClick={() => run(() => api.put('/account/alerts', f), 'Alert choices saved')}>Save</Button>
        <Button busy={busy} onClick={sendTest}>Send test alert</Button>
      </div>
    </Section>
  );
}

const hourLabel = (hour: number) => `${hour % 12 || 12}:00 ${hour % 24 < 12 ? 'AM' : 'PM'}`;

/** Alerts held by quiet hours are not sent later, so people need to know the window. */
function QuietNote({ quiet }: { quiet: { now: boolean; start: number; end: number } }) {
  if (!quiet.now) return null;
  return <Notice>Quiet hours are on until {hourLabel(quiet.end)}. Alerts until then stay in the bell and do not reach your phone. The test button still works.</Notice>;
}

const NO_TOKEN = 'This phone has no notification ID from Google yet. Check your internet and Google Play services, then reopen the app.';

function AppPushSection({ ready, devices, reload }: { ready: boolean; devices: number; reload: () => void }) {
  const on = ready && devices > 0;
  const { busy, run } = useAction();
  const connect = () => run(async () => {
    const result = await registerDevice();
    if (result === 'no-token') throw new Error(NO_TOKEN);
    if (result !== 'ok') throw new Error('Could not register this phone. Please try again.');
    reload();
  }, 'This phone is connected');
  return (
    <Section icon={<Bell size={20} />} title="Phone notifications" hint="Get alerts for new leads and approvals, even when the app is closed. No customer details are shown on the lock screen."
      status={<Badge tone={on ? 'green' : 'neutral'}>{on ? 'On' : 'Off'}</Badge>}>
      <p className="text-sm text-muted">
        {!ready ? 'Your administrator has not finished setting up app notifications.'
          : on ? 'This phone is registered. If a test alert does not appear, allow notifications for Archstone Connect in your phone settings and turn off battery saving for the app.'
          : 'This phone is not registered yet.'}
      </p>
      {ready && !on && <Button className="mt-2" busy={busy} onClick={connect}>Connect this phone</Button>}
    </Section>
  );
}

function PushSection({ enabled, publicKey, onChange }: { enabled: boolean; publicKey: string; onChange: () => void }) {
  const { busy, run } = useAction();
  const supported = webPushSupported();

  const turnOn = () => run(async () => {
    await enableWebPush(publicKey, (sub) => api.post('/account/push', sub));
    onChange();
  }, 'Notifications are on for this device');

  const turnOff = () => run(async () => {
    const registration = await navigator.serviceWorker.ready;
    const sub = await registration.pushManager.getSubscription();
    if (sub) {
      await api.post('/account/push/remove', { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    onChange();
  }, 'Notifications are off');

  return (
    <Section icon={<Bell size={20} />} title="Phone notifications" hint="Get alerts for new leads and approvals, even when the app is closed. No customer details are shown on the lock screen."
      status={<Badge tone={enabled ? 'green' : 'neutral'}>{enabled ? 'On' : 'Off'}</Badge>}>
      {supported
        ? <Button busy={busy} onClick={enabled ? turnOff : turnOn}>{enabled ? 'Turn off' : 'Turn on for this device'}</Button>
        : <p className="text-sm text-muted">This browser does not support notifications. Install the app to your home screen first.</p>}
    </Section>
  );
}

export default function Account() {
  const { user, refresh } = useAuth();
  const { data, error, loading, reload } = useApi('/account');
  const { data: history } = useApi('/account/logins');
  const [settingUp, setSettingUp] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [password, setPassword] = useState('');
  const [change, setChange] = useState({ current: '', next: '' });
  const { busy, run } = useAction();

  if (loading) return <Spinner />;
  if (error || !data) return <Page><ErrorNote>{error}</ErrorNote></Page>;

  const connectGoogle = async () => {
    const r = await run(() => api.get('/google/connect'));
    if (r) location.assign(r.url);
  };
  const disconnectGoogle = async () => {
    await run(() => api.post('/google/disconnect'), 'Google disconnected');
    void reload();
  };
  const disable = async () => {
    if (await run(() => api.post('/account/2fa/disable', { password }), 'Two-factor login is off')) {
      setDisabling(false);
      setPassword('');
      void reload();
      void refresh();
    }
  };
  const savePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post('/auth/password', change), 'Password changed')) setChange({ current: '', next: '' });
  };

  return (
    <Page>
      <PageHeader title="My Account" subtitle={`${user!.name} · ${ROLE_LABELS[user!.role]} · ${user!.email}`} />
      <div className="max-w-2xl space-y-3">
        <Section icon={<ShieldCheck size={20} />} title="Two-factor login" hint="A code from your phone keeps your account safe if your password leaks."
          status={<Badge tone={data.two_factor ? 'green' : 'amber'}>{data.two_factor ? 'On' : 'Off'}</Badge>}>
          {data.two_factor ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-muted">{data.recovery_left} recovery codes left</span>
              <Button onClick={() => setDisabling(true)}>Turn off</Button>
            </div>
          ) : settingUp
            ? <TwoFactorSetup onDone={() => { setSettingUp(false); void reload(); void refresh(); }} />
            : <Button variant="primary" onClick={() => setSettingUp(true)}>Set up</Button>}
        </Section>

        <AlertChoices prefs={data.alert_prefs} hasPhone={data.has_phone} />
        {inAndroidApp()
          ? <AppPushSection ready={data.app_push_ready} devices={data.app_devices} reload={reload} />
          : <PushSection enabled={data.push_enabled} publicKey={data.push_key} onChange={reload} />}
        <QuietNote quiet={data.quiet} />

        <Section icon={<CalendarDays size={20} />} title="Google account" hint="Adds your site visits to Calendar, and lets you save contacts and copy documents to Drive."
          status={<Badge tone={data.google_connected ? 'green' : 'neutral'}>{data.google_connected ? 'Connected' : 'Not connected'}</Badge>}>
          {data.google_connected
            ? <div className="flex items-center gap-3"><span className="text-sm">{data.google_email}</span><Button onClick={disconnectGoogle}>Disconnect</Button></div>
            : data.google_available
              ? <Button busy={busy} onClick={connectGoogle}>Connect Google</Button>
              : <p className="text-sm text-muted">Your administrator needs to add Google keys in Settings first.</p>}
        </Section>

        <Section icon={<KeyRound size={20} />} title="Change password" hint="At least 10 characters.">
          <form onSubmit={savePassword} className="grid gap-3 sm:grid-cols-2">
            <TextField label="Current password" type="password" autoComplete="current-password" required value={change.current} onChange={(e) => setChange({ ...change, current: e.target.value })} />
            <TextField label="New password" type="password" autoComplete="new-password" required minLength={10} value={change.next} onChange={(e) => setChange({ ...change, next: e.target.value })} />
            <div><Button type="submit" busy={busy}>Change password</Button></div>
          </form>
        </Section>
        <Card className="p-4">
          <h2 className="text-[15px] font-semibold">Sign-in history</h2>
          <p className="text-sm text-muted">{history?.sessions ?? 0} active session{history?.sessions === 1 ? '' : 's'}. Report anything you do not recognise.</p>
          <ul className="mt-2 divide-y divide-line text-sm">{history?.logins.map((l: any) => <li key={l.created_at} className="flex justify-between py-1"><span>{dateTime(l.created_at)}</span><span className="text-muted">{l.ip}</span></li>)}</ul>
        </Card>
      </div>
      {disabling && (
        <Modal title="Turn off two-factor login" onClose={() => setDisabling(false)}>
          <TextField label="Confirm your password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <div className="mt-3 flex justify-end gap-2"><Button onClick={() => setDisabling(false)}>Cancel</Button><Button variant="danger" busy={busy} onClick={disable}>Turn off</Button></div>
        </Modal>
      )}
    </Page>
  );
}
