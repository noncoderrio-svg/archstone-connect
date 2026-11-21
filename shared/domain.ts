// Shared by the server and the web app, so labels and rules cannot drift apart.

/** Company details printed on cost sheets and receipts. Fill in the office address before going live. */
export const COMPANY = {
  name: 'Archstone',
  tagline: 'Design. Build. Deliver.',
  address: '',
} as const;

/** Top to bottom. Every role list in the server and the screens comes from this file. */
export const ROLES = ['admin', 'site_head', 'sourcing_manager', 'closing_manager', 'payment_followup', 'telecaller'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  site_head: 'Site Head',
  sourcing_manager: 'Sourcing Manager',
  closing_manager: 'Closing Manager',
  payment_followup: 'Payment Follow-up',
  telecaller: 'Telecaller',
};

/** Roles from earlier versions, and the role each one became. Used once, at start-up. */
export const LEGACY_ROLES: Record<string, Role> = {
  sales_manager: 'sourcing_manager',
  team_leader: 'closing_manager',
  sales: 'closing_manager',
  marketing: 'telecaller',
};

/** Roles that can have people reporting to them and can watch their team's work. */
export const MANAGER_ROLES: readonly Role[] = ['admin', 'site_head', 'sourcing_manager', 'closing_manager'];
/** Roles that work leads: calling, follow-ups, assignment and performance lists. */
export const LEAD_ROLES: readonly Role[] = ['site_head', 'sourcing_manager', 'closing_manager', 'telecaller'];
/** Roles a telecaller can hand a qualified lead to. */
export const CLOSING_ROLES: readonly Role[] = ['site_head', 'sourcing_manager', 'closing_manager'];
/** Roles that may view buyers but never work leads. */
export const VIEW_ONLY_ROLES: readonly Role[] = ['payment_followup'];
/** Roles that see bookings and payments. */
export const BOOKING_ROLES: readonly Role[] = ['admin', 'site_head', 'sourcing_manager', 'closing_manager', 'payment_followup'];

export const isManager = (role: string) => (MANAGER_ROLES as readonly string[]).includes(role);
export const isLeadRole = (role: string) => (LEAD_ROLES as readonly string[]).includes(role);
export const isViewOnly = (role: string) => (VIEW_ONLY_ROLES as readonly string[]).includes(role);

/** Which leads each role sees, unless an admin sets something else for one person. */
export const DEFAULT_SCOPE: Record<Role, 'all' | 'projects' | 'team' | 'own' | 'bookings'> = {
  admin: 'all',
  site_head: 'projects',
  sourcing_manager: 'team',
  closing_manager: 'team',
  payment_followup: 'bookings',
  telecaller: 'own',
};

export const STAGES = [
  'Not Contacted',
  'Contacted',
  'Qualified',
  'Site Visit Scheduled',
  'Site Visit Done',
  'Working Deal',
  'Booked',
  'Future Prospect',
  'Did Not Respond',
  'Unqualified',
  'Lost',
] as const;
export type Stage = (typeof STAGES)[number];

/** The stages shown as columns on the pipeline board, in funnel order. */
export const BOARD_STAGES: Stage[] = [
  'Not Contacted',
  'Contacted',
  'Qualified',
  'Site Visit Scheduled',
  'Site Visit Done',
  'Working Deal',
  'Booked',
];

export const SOURCES = [
  'Website',
  'Meta Ads',
  'Google Ads',
  'WhatsApp',
  '99acres',
  'MagicBricks',
  'Housing.com',
  'Walk-in',
  'Referral',
  'Channel Partner',
  'Sheet Upload',
  'Manual',
] as const;
export type Source = (typeof SOURCES)[number];

export const DISPOSITIONS = [
  'Connected',
  'Interested',
  'Not Reachable',
  'Busy',
  'Call Back',
  'Tentative',
  'Low Budget',
  'Broker',
  'Not To Pitch',
  'Not Interested',
  'Wrong Number',
  'Qualified',
] as const;

/** Extra buyer details, kept together so a new question needs no database change. */
export const BUYER_FIELDS = [
  { key: 'occupation', label: 'Occupation' },
  { key: 'address', label: 'Address' },
  { key: 'date_of_birth', label: 'Date of birth', type: 'date' },
  { key: 'property_type', label: 'Property type', options: ['Residential', 'Commercial'] },
  { key: 'preferred_floor', label: 'Preferred floor' },
  { key: 'purpose', label: 'Reason for purchase', options: ['Self use', 'Investment'] },
  { key: 'funding', label: 'Funding', options: ['Self', 'Loan', 'Self and loan'] },
  { key: 'best_time', label: 'Best time to contact', options: ['Morning', 'Afternoon', 'Evening'] },
  { key: 'heard_from', label: 'How they heard about us', options: ['Hoarding', 'Online', 'SMS or email', 'Friends or relatives', 'IVR', 'Others'] },
  { key: 'broker_name', label: 'Broker name' },
  { key: 'broker_contact', label: 'Broker contact' },
] as const;

export const LOST_REASONS = [
  'Budget mismatch',
  'Location mismatch',
  'Bought elsewhere',
  'Not responding',
  'Plan postponed',
  'Other',
] as const;

export const DOCUMENT_TYPES = ['PAN', 'Aadhaar', 'Address proof', 'Photo', 'Agreement', 'Payment proof', 'Other'] as const;

export const HANDOVER_STAGES = ['Booking', 'Agreement', 'Registration', 'Possession', 'Handed Over'] as const;

export const REDEVELOPMENT_SCHEMES = ['SRA', 'Private Land', 'Government Land', 'BMC Land'] as const;

export const ALERT_KINDS = [
  { key: 'new_lead', label: 'New leads' },
  { key: 'followup', label: 'Follow-up reminders' },
  { key: 'overdue', label: 'Overdue follow-ups' },
  { key: 'team', label: 'Team escalations' },
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number]['key'];

export const ALERT_DEFAULTS = {
  reminder_minutes: 15,
  overdue_repeat_minutes: 60,
  overdue_max_alerts: 3,
  escalate_after_minutes: 120,
  quiet_enabled: true,
  quiet_start: 21,
  quiet_end: 8,
  morning_summary: true,
  summary_hour: 9,
  whatsapp_new_lead: true,
  whatsapp_followup: true,
  whatsapp_overdue: true,
};

export const REDEVELOPMENT_STAGES = [
  'Identified',
  'Site Survey',
  'Feasibility',
  'Society Talks',
  'Consent / LOI',
  'Agreement',
  'Approvals',
  'Construction',
  'Closed',
  'Dropped',
] as const;

/** Everything an admin can switch on or off, grouped as shown on the permissions screen. */
export const PERMISSION_GROUPS = [
  {
    group: 'Leads',
    items: [
      ['lead.create', 'Add leads'],
      ['lead.reassign', 'Reassign leads'],
      ['lead.import', 'Import leads'],
      ['lead.export', 'Export leads'],
      ['lead.delete', 'Delete and erase leads'],
    ],
  },
  {
    group: 'WhatsApp',
    items: [
      ['whatsapp.send', 'Send WhatsApp messages'],
      ['campaign.create', 'Create broadcasts'],
      ['campaign.approve', 'Approve broadcasts'],
      ['campaign.direct', 'Send broadcasts without approval'],
      ['template.manage', 'Manage templates'],
      ['whatsapp.monitor', 'Monitor all inboxes'],
    ],
  },
  {
    group: 'Sales',
    items: [
      ['call.office', 'Call through the office line'],
      ['visit.checkin', 'Check in site visits'],
      ['unit.hold', 'Hold a flat'],
      ['unit.book', 'Book a flat'],
      ['inventory.manage', 'Manage units'],
      ['approval.review', 'Approve bookings and discounts'],
      ['booking.manage', 'Manage bookings and payment schedules'],
      ['payment.record', 'Record payments received'],
      ['payment.followup', 'Log payment follow-ups'],
      ['partner.manage', 'Manage channel partners'],
      ['redevelopment.manage', 'Manage redevelopment deals'],
    ],
  },
  {
    group: 'Content and AI',
    items: [
      ['media.manage', 'Upload and delete property files'],
      ['ai.use', 'Use the AI assistant'],
    ],
  },
  {
    group: 'Marketing AI',
    items: [
      ['marketing.use', 'Use the AI marketing team: briefs, drafts and reports'],
      ['marketing.approve', 'Approve what the AI team sends to Meta, including budgets'],
    ],
  },
  {
    group: 'Workplace',
    items: [
      ['bulletin.view', 'See the bulletin bar'],
      ['bulletin.manage', 'Write bulletin messages'],
      ['duty.manage', 'Set weekly offs, shifts and absences for their team'],
      ['kyc.view', 'See KYC numbers and open KYC documents'],
    ],
  },
  {
    group: 'Administration',
    items: [
      ['reports.view', 'View reports'],
      ['user.manage', 'Manage users'],
      ['settings.manage', 'Change settings'],
      ['audit.view', 'View the audit log'],
    ],
  },
] as const;

export type Action = (typeof PERMISSION_GROUPS)[number]['items'][number][0];
export const ACTIONS = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i[0])) as Action[];

const EVERYONE: Action[] = ['lead.create', 'whatsapp.send', 'campaign.create', 'call.office', 'ai.use', 'bulletin.view'];

/** Starting points. An admin can change any of these, by role or for one person. */
export const PERMISSIONS: Record<Role, Action[]> = {
  admin: [...ACTIONS],
  site_head: [...EVERYONE, 'unit.hold', 'unit.book', 'payment.record', 'payment.followup', 'lead.reassign', 'inventory.manage', 'partner.manage', 'approval.review', 'reports.view', 'visit.checkin', 'booking.manage', 'redevelopment.manage', 'media.manage', 'duty.manage', 'kyc.view'],
  sourcing_manager: [...EVERYONE, 'unit.hold', 'unit.book', 'payment.record', 'payment.followup', 'lead.reassign', 'lead.import', 'lead.export', 'approval.review', 'reports.view', 'visit.checkin', 'booking.manage', 'partner.manage', 'media.manage', 'duty.manage', 'kyc.view'],
  closing_manager: [...EVERYONE, 'unit.hold', 'lead.reassign', 'approval.review', 'reports.view', 'visit.checkin', 'duty.manage', 'kyc.view'],
  payment_followup: ['ai.use', 'payment.record', 'payment.followup', 'bulletin.view', 'kyc.view'],
  telecaller: [...EVERYONE, 'unit.hold', 'kyc.view'],
};

/**
 * Permissions added after the first release, with the version that added them. Saved role sets get the defaults once.
 * With `when`, a saved set gets them only if it already had that permission, so an admin's earlier choice still holds.
 */
export const ADDED_ACTIONS: { version: number; actions: Action[]; when?: Action }[] = [
  { version: 3, actions: ['unit.hold', 'unit.book'] },
  { version: 4, actions: ['payment.record', 'payment.followup'], when: 'booking.manage' },
  // Everyone who could open KYC documents before keeps that; the rest are new.
  { version: 5, actions: ['bulletin.view', 'duty.manage', 'kyc.view'] },
];

/**
 * Features an admin switches on or off for the whole company in Settings → Features.
 * Who may see and use each one is then set on the Permissions screen.
 */
export const FEATURES = [
  { key: 'bulletin', label: 'Bulletin bar', hint: 'Scrolling messages under the top bar: targets, launches, offers, birthdays.', default: true },
  { key: 'duty', label: 'Weekly offs, shifts and duty-aware assignment', hint: 'New leads go only to people on duty today. Absent people can hand their follow-ups to a teammate.', default: false },
  { key: 'app', label: 'Mobile app download', hint: 'The /app download page with a QR code, and a download button on the sign-in page. Upload the app in Settings → Mobile app.', default: true },
  { key: 'kyc', label: 'KYC number checks', hint: 'Aadhaar is checked and kept as the last 4 digits only. PAN is format-checked. Who opens a lead or a document is logged.', default: true },
  { key: 'marketing', label: 'AI marketing team', hint: 'Eight AI agents that plan Meta campaigns, write ads, read results and report. Nothing reaches Meta or spends money without an approval.', default: false },
] as const;
export type FeatureKey = (typeof FEATURES)[number]['key'];
export type FeatureSwitches = Record<FeatureKey, boolean>;
export const FEATURE_DEFAULTS = Object.fromEntries(FEATURES.map((f) => [f.key, f.default])) as FeatureSwitches;

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** Verhoeff checksum, the check digit scheme Aadhaar numbers use. */
const VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
export function verhoeffValid(digits: string) {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  [...digits].reverse().forEach((d, i) => { c = VD[c][VP[i % 8][Number(d)]]; });
  return c === 0;
}
/** 12 digits, not starting with 0 or 1, passing the Verhoeff check. Spaces and dashes are ignored. */
export const aadhaarValid = (raw: string) => {
  const d = raw.replace(/[\s-]/g, '');
  return /^[2-9]\d{11}$/.test(d) && verhoeffValid(d);
};
/** Five letters, four digits, one letter; the fourth letter says what kind of holder it is. */
export const panValid = (raw: string) => /^[A-Z]{3}[ABCFGHLJPTK][A-Z]\d{4}[A-Z]$/.test(raw.trim().toUpperCase());

/** Monthly goals. Each role is measured on its own work. */
export const GOALS = {
  calls: { label: 'Calls' },
  qualified: { label: 'Qualified leads' },
  visits: { label: 'Site visits' },
  bookings: { label: 'Bookings' },
  partner_contacts: { label: 'Partner contacts' },
  partner_visits: { label: 'Partner site visits' },
  partner_bookings: { label: 'Partner bookings' },
  payment_followups: { label: 'Payment follow-ups' },
  collected_lakhs: { label: 'Amount collected', unit: 'lakhs' },
} as const satisfies Record<string, { label: string; unit?: string }>;
export type GoalKey = keyof typeof GOALS;

export const ROLE_GOALS: Record<Role, GoalKey[]> = {
  admin: [],
  site_head: ['visits', 'bookings', 'collected_lakhs'],
  sourcing_manager: ['partner_contacts', 'partner_visits', 'partner_bookings'],
  closing_manager: ['calls', 'visits', 'bookings'],
  payment_followup: ['payment_followups', 'collected_lakhs'],
  telecaller: ['calls', 'qualified', 'visits'],
};

/**
 * "Target met" is the average of each goal's progress, each capped at 100%,
 * so one large number cannot hide a missed goal. Goals with no target are left out; no target at all means no score.
 */
export function targetMet(goals: { target: number; actual: number }[]): number | null {
  const set = goals.filter((g) => g.target > 0);
  if (!set.length) return null;
  return Math.round((set.reduce((sum, g) => sum + Math.min(1, g.actual / g.target), 0) / set.length) * 100);
}

/** What a buyer said when asked about a payment. */
export const PAYMENT_OUTCOMES = ['Promised to pay', 'Asked for more time', 'No answer', 'Loan in process', 'Dispute', 'Other'] as const;

/** Prefix for new receipt numbers. Receipts already issued keep their number. */
export const RECEIPT_PREFIX = 'AS';

export const DATA_SCOPES = [
  { value: '', label: 'Default for role' },
  { value: 'own', label: 'Own leads only' },
  { value: 'team', label: 'Own and their team' },
  { value: 'projects', label: 'Assigned projects' },
  { value: 'all', label: 'All leads' },
  { value: 'bookings', label: 'Buyers on assigned projects' },
] as const;

/** Variables a WhatsApp template may use. */
export const TEMPLATE_VARS = ['name', 'project', 'location', 'price', 'rera', 'agent', 'visit_time', 'otp', 'amount', 'due_date', 'milestone', 'period', 'summary'] as const;

/** Starting labels. An admin can rename, add or remove them in Settings. */
export const DEFAULT_LABELS = [
  { name: 'Hot Buyer', color: 'red' },
  { name: 'Investor', color: 'violet' },
  { name: 'NRI', color: 'teal' },
  { name: 'Site Visit Pending', color: 'amber' },
  { name: 'Loan Needed', color: 'green' },
  { name: 'Broker', color: 'slate' },
];

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi' },
  { code: 'mr', label: 'Marathi' },
] as const;
