// Shared by the server and the web app, so labels and rules cannot drift apart.

/** Company details printed on cost sheets and receipts. Fill in the office address before going live. */
export const COMPANY = {
  name: 'Archstone',
  tagline: 'Design. Build. Deliver.',
  address: '',
} as const;

export const ROLES = ['admin', 'sales_manager', 'site_head', 'team_leader', 'marketing', 'sales', 'telecaller'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  sales_manager: 'Sales Manager',
  site_head: 'Site Head',
  team_leader: 'Team Leader',
  marketing: 'Marketing',
  sales: 'Sales Person',
  telecaller: 'Pre-Sales Telecaller',
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
  sales_manager: [...EVERYONE, 'lead.reassign', 'lead.import', 'lead.export', 'approval.review', 'reports.view', 'visit.checkin', 'booking.manage', 'partner.manage', 'media.manage'],
  site_head: [...EVERYONE, 'lead.reassign', 'inventory.manage', 'approval.review', 'reports.view', 'visit.checkin', 'booking.manage', 'redevelopment.manage', 'media.manage'],
  team_leader: [...EVERYONE, 'lead.reassign', 'approval.review', 'reports.view', 'visit.checkin'],
  marketing: ['campaign.create', 'ai.use', 'lead.import', 'template.manage', 'reports.view', 'media.manage'],
  sales: [...EVERYONE, 'visit.checkin'],
  telecaller: [...EVERYONE],
};

export const DATA_SCOPES = [
  { value: '', label: 'Default for role' },
  { value: 'own', label: 'Own leads only' },
  { value: 'team', label: 'Own and their team' },
  { value: 'projects', label: 'Assigned projects' },
  { value: 'all', label: 'All leads' },
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
