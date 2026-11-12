import { StrictMode, lazy, Suspense, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { lazyPage, pageLoadSettled } from './lib/lazy.ts';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout.tsx';
import { Logo, Spinner, ToastProvider } from './components/ui.tsx';
import { AuthProvider, useAuth } from './lib/auth.tsx';
import './lib/install.ts';
import { ChangePassword, Login } from './pages/Login.tsx';
import './styles.css';

const Dashboard = lazyPage(() => import('./pages/Dashboard.tsx'));
const Leads = lazyPage(() => import('./pages/Leads.tsx'));
const LeadDetail = lazyPage(() => import('./pages/LeadDetail.tsx'));
const Inbox = lazyPage(() => import('./pages/Inbox.tsx'));
const Campaigns = lazyPage(() => import('./pages/Campaigns.tsx'));
const Projects = lazyPage(() => import('./pages/Projects.tsx'));
const Visits = lazyPage(() => import('./pages/Visits.tsx'));
const Approvals = lazyPage(() => import('./pages/Approvals.tsx'));
const Reports = lazyPage(() => import('./pages/Reports.tsx'));
const Team = lazyPage(() => import('./pages/Team.tsx'));
const Settings = lazyPage(() => import('./pages/Settings.tsx'));
const Account = lazyPage(() => import('./pages/Account.tsx'));
const Calendar = lazyPage(() => import('./pages/Calendar.tsx'));
const FollowUps = lazyPage(() => import('./pages/FollowUps.tsx'));
const LeadRouting = lazyPage(() => import('./pages/LeadRouting.tsx'));
const Performance = lazyPage(() => import('./pages/Performance.tsx'));
const BuyerPortal = lazyPage(() => import('./pages/BuyerPortal.tsx'));
const Dialer = lazyPage(() => import('./pages/Dialer.tsx'));
const Media = lazyPage(() => import('./pages/Media.tsx'));
const Monitor = lazyPage(() => import('./pages/Monitor.tsx'));
const Bookings = lazyPage(() => import('./pages/Bookings.tsx'));
const Payments = lazyPage(() => import('./pages/Payments.tsx'));
const Receipt = lazyPage(() => import('./pages/Bookings.tsx').then((m) => ({ default: m.Receipt })));
const CostSheet = lazyPage(() => import('./pages/CostSheet.tsx'));
const Partners = lazyPage(() => import('./pages/Partners.tsx'));
const Redevelopment = lazyPage(() => import('./pages/Redevelopment.tsx'));
const TwoFactorSetup = lazyPage(() => import('./pages/Account.tsx').then((m) => ({ default: m.TwoFactorSetup })));

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js');
}

void pageLoadSettled();

const Lazy = ({ children }: { children: ReactNode }) => <Suspense fallback={<Spinner />}>{children}</Suspense>;

function ForcedTwoFactor() {
  const { refresh, logout } = useAuth();
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface p-6">
      <div className="w-full max-w-sm">
        <Logo className="mx-auto mb-6 w-64" />
        <h1 className="text-center font-display text-2xl font-semibold">Protect this account</h1>
        <p className="mt-1 mb-5 text-center text-muted">Admin accounts need two-factor login.</p>
        <Lazy><TwoFactorSetup onDone={refresh} /></Lazy>
        <button className="mt-4 w-full text-sm text-muted" onClick={logout}>Sign out</button>
      </div>
    </div>
  );
}

function Root() {
  const { user, loading, mustSetupTwoFactor } = useAuth();
  if (loading) return <Spinner />;
  if (!user) return <Login />;
  if (user.must_change_password) return <ChangePassword />;
  if (mustSetupTwoFactor) return <ForcedTwoFactor />;
  return (
    <BrowserRouter>
      <Routes>
        <Route path="leads/:id/cost-sheet" element={<Lazy><CostSheet /></Lazy>} />
        <Route path="bookings/:id/receipt/:paymentId" element={<Lazy><Receipt /></Lazy>} />
        <Route element={<Layout />}>
          <Route index element={<Lazy><Dashboard /></Lazy>} />
          <Route path="leads" element={<Lazy><Leads /></Lazy>} />
          <Route path="leads/:id" element={<Lazy><LeadDetail /></Lazy>} />
          <Route path="inbox" element={<Lazy><Inbox /></Lazy>} />
          <Route path="inbox/:id" element={<Lazy><Inbox /></Lazy>} />
          <Route path="campaigns" element={<Lazy><Campaigns /></Lazy>} />
          <Route path="projects" element={<Lazy><Projects /></Lazy>} />
          <Route path="projects/:id" element={<Lazy><Projects /></Lazy>} />
          <Route path="visits" element={<Lazy><Visits /></Lazy>} />
          <Route path="approvals" element={<Lazy><Approvals /></Lazy>} />
          <Route path="reports" element={<Lazy><Reports /></Lazy>} />
          <Route path="team" element={<Lazy><Team /></Lazy>} />
          <Route path="settings" element={<Lazy><Settings /></Lazy>} />
          <Route path="account" element={<Lazy><Account /></Lazy>} />
          <Route path="calendar" element={<Lazy><Calendar /></Lazy>} />
          <Route path="followups" element={<Lazy><FollowUps /></Lazy>} />
          <Route path="routing" element={<Lazy><LeadRouting /></Lazy>} />
          <Route path="performance" element={<Lazy><Performance /></Lazy>} />
          <Route path="dial" element={<Lazy><Dialer /></Lazy>} />
          <Route path="files" element={<Lazy><Media /></Lazy>} />
          <Route path="monitor" element={<Lazy><Monitor /></Lazy>} />
          <Route path="bookings" element={<Lazy><Bookings /></Lazy>} />
          <Route path="payments" element={<Lazy><Payments /></Lazy>} />
          <Route path="partners" element={<Lazy><Partners /></Lazy>} />
          <Route path="redevelopment" element={<Lazy><Redevelopment /></Lazy>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

const buyerToken = location.pathname.match(/^\/buyer\/([\w-]+)$/)?.[1];

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {buyerToken ? <Lazy><BuyerPortal token={buyerToken} /></Lazy> : (
      <AuthProvider>
        <ToastProvider>
          <Root />
        </ToastProvider>
      </AuthProvider>
    )}
  </StrictMode>,
);
