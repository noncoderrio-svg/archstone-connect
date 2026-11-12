// Explainable, rule-based insights. They work with no AI key, and AI only refines them.

export const INTENTS = ['price', 'site visit', 'brochure', 'home loan', 'possession', 'location', 'not interested', 'general'] as const;

const INTENT_WORDS: [string, string[]][] = [
  ['not interested', ['not interested', 'no need', 'dont call', "don't call", 'nahi chahiye', 'नहीं चाहिए', 'रुचि नहीं', 'नको']],
  ['price', ['price', 'cost', 'rate', 'budget', 'kitna', 'kimat', 'कीमत', 'किंमत', 'दाम', 'भाव']],
  ['site visit', ['visit', 'site', 'see the flat', 'dekhna', 'देखना', 'भेट', 'पाहायला']],
  ['brochure', ['brochure', 'details', 'floor plan', 'layout', 'ब्रोशर', 'माहिती']],
  ['home loan', ['loan', 'emi', 'bank', 'लोन', 'कर्ज']],
  ['possession', ['possession', 'ready', 'handover', 'कब मिलेगा', 'ताबा']],
  ['location', ['location', 'address', 'where', 'kaha', 'कहाँ', 'पत्ता', 'कुठे']],
];

const NEGATIVE = ['not interested', 'angry', 'worst', 'bad', 'cheat', 'fraud', 'complaint', 'too expensive', 'costly', 'stop calling', 'disappointed', 'खराब', 'बेकार', 'महंगा', 'वाईट', 'महाग'];
const POSITIVE = ['great', 'good', 'interested', 'thank', 'yes', 'love', 'perfect', 'book', 'ready to', 'अच्छा', 'धन्यवाद', 'हाँ', 'छान', 'आभारी', 'हो'];

export function classifyMessage(text: string) {
  const t = text.toLowerCase();
  const intent = INTENT_WORDS.find(([, words]) => words.some((w) => t.includes(w)))?.[0] ?? 'general';
  let sentiment = 'neutral';
  if (NEGATIVE.some((w) => t.includes(w))) sentiment = 'negative';
  else if (POSITIVE.some((w) => t.includes(w))) sentiment = 'positive';
  return { sentiment, intent };
}

interface LeadFacts {
  stage: string;
  do_not_contact: number;
  unread_count: number;
  intent: string;
  overdueTasks: number;
  hasOpenTask: boolean;
  hasUpcomingVisit: boolean;
  windowOpen: boolean;
  hasBooking: boolean;
  documents: number;
}

/** The single most useful next step for a lead, with the reason it was chosen. */
export function nextBestAction(l: LeadFacts): { action: string; reason: string } {
  if (l.do_not_contact) return { action: 'Do not contact this person', reason: 'They are on the do-not-contact list.' };
  if (l.unread_count) {
    const topic = l.intent && l.intent !== 'general' ? ` about ${l.intent}` : '';
    return { action: `Reply on WhatsApp${topic}`, reason: 'The customer is waiting for an answer.' };
  }
  if (l.overdueTasks) return { action: 'Complete the overdue follow-up', reason: `${l.overdueTasks} follow-up${l.overdueTasks > 1 ? 's are' : ' is'} past due.` };
  if (l.hasBooking) {
    return l.documents
      ? { action: 'Check the payment schedule', reason: 'This lead has an active booking.' }
      : { action: 'Collect KYC documents', reason: 'This booking has no documents yet.' };
  }
  switch (l.stage) {
    case 'Not Contacted': return { action: 'Call now', reason: 'New leads respond best within minutes.' };
    case 'Contacted': return { action: 'Qualify budget and timeline', reason: 'Contact is made, but the need is not confirmed.' };
    case 'Qualified': return l.hasUpcomingVisit ? { action: 'Confirm the site visit', reason: 'A visit is coming up.' } : { action: 'Schedule a site visit', reason: 'Qualified leads convert best after seeing the site.' };
    case 'Site Visit Scheduled': return { action: 'Confirm the visit a day before', reason: 'Reminders reduce no-shows.' };
    case 'Site Visit Done': return { action: 'Share a cost sheet', reason: 'The visit is done, so the next step is the numbers.' };
    case 'Working Deal': return { action: 'Raise a booking request', reason: 'This deal is in negotiation.' };
    case 'Future Prospect': return { action: 'Set a follow-up date', reason: 'Future prospects are easy to lose without one.' };
    case 'Did Not Respond': return l.windowOpen ? { action: 'Send a WhatsApp reply', reason: 'The reply window is open.' } : { action: 'Try an approved template', reason: 'Calls have not connected.' };
    case 'Lost': return { action: 'Add to a re-engagement campaign', reason: 'New launches can bring lost leads back.' };
    default: return l.hasOpenTask ? { action: 'Work the open follow-up', reason: 'A task is scheduled.' } : { action: 'Set a next action', reason: 'No lead should sit without one.' };
  }
}
