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
      ['booking.manage', 'Manage bookings and payments'],
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

const EVERYONE: Action[] = ['lead.create', 'whatsapp.send', 'campaign.create', 'call.office', 'ai.use'];

/** Starting points. An admin can change any of these, by role or for one person. */
export const PERMISSIONS: Record<Role, Action[]> = {
  admin: [...ACTIONS],
  site_head: [...EVERYONE, 'unit.hold', 'unit.book', 'lead.reassign', 'inventory.manage', 'partner.manage', 'approval.review', 'reports.view', 'visit.checkin', 'booking.manage', 'redevelopment.manage', 'media.manage'],
  sourcing_manager: [...EVERYONE, 'unit.hold', 'unit.book', 'lead.reassign', 'lead.import', 'lead.export', 'approval.review', 'reports.view', 'visit.checkin', 'booking.manage', 'partner.manage', 'media.manage'],
  closing_manager: [...EVERYONE, 'unit.hold', 'lead.reassign', 'approval.review', 'reports.view', 'visit.checkin'],
  payment_followup: ['ai.use'],
  telecaller: [...EVERYONE, 'unit.hold'],
};

/** Permissions added after the first release, with the version that added them. Saved role sets get the defaults once. */
export const ADDED_ACTIONS: { version: number; actions: Action[] }[] = [
  { version: 3, actions: ['unit.hold', 'unit.book'] },
];

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
