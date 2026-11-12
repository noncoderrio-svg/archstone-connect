// WhatsApp qualification chatbot. This file is the conversation only: it takes
// the customer's text and returns what to say and save. It never invents facts:
// projects, prices and brochures all come from the Project Master.

export interface BotProject {
  id: number;
  name: string;
  location: string;
  configuration: string;
  price_from_lakhs: number | null;
  brochure_url: string;
}

export type BotLanguage = 'en' | 'hi' | 'mr';

export interface BotStep {
  reply: string;
  state: string;
  tries: number;
  language?: BotLanguage;
  save?: { project_id?: number | null; configuration?: string; timeline?: string; budget_lakhs?: number };
  wantsVisit?: boolean;
  finished?: boolean;
  handover?: boolean;
}

const TIMELINES = ['Immediately', 'Within 3 months', 'Within 6 months', 'Exploring'];
const HUMAN_WORDS = ['agent', 'human', 'person', 'call me', 'callback', 'call back', 'talk', 'baat', 'कॉल', 'बात', 'फोन करा'];
const MAX_TRIES = 2;

const TEXT: Record<BotLanguage, Record<string, string>> = {
  en: {
    project: 'Which project are you interested in? Reply with a number:',
    notSure: 'Not sure yet',
    help: 'Reply AGENT at any time to reach our team, or STOP to opt out.',
    size: 'Which home size do you prefer? For example: Studio, 1 BHK or 2 BHK.',
    available: 'Available',
    from: 'Starting from',
    brochure: 'Brochure',
    when: 'When are you planning to buy? Reply with a number:\n1. Immediately\n2. Within 3 months\n3. Within 6 months\n4. Just exploring',
    budget: 'Thank you. What is your approximate budget? For example: 90 lakh or 1.2 crore.',
    visit: 'Would you like to visit the site? Reply 1 for Yes or 2 for No.',
    fix: 'Thank you. Our team will call you to fix a suitable time.',
    handover: 'Thank you. Our team will contact you shortly.',
    missed: 'Sorry, I did not catch that.',
  },
  hi: {
    project: 'आप किस प्रोजेक्ट में रुचि रखते हैं? कृपया नंबर से जवाब दें:',
    notSure: 'अभी तय नहीं',
    help: 'हमारी टीम से बात करने के लिए AGENT लिखें। संदेश बंद करने के लिए STOP लिखें।',
    size: 'आपको कौन सा घर चाहिए? जैसे: Studio, 1 BHK या 2 BHK।',
    available: 'उपलब्ध',
    from: 'शुरुआती कीमत',
    brochure: 'ब्रोशर',
    when: 'आप कब खरीदना चाहते हैं? कृपया नंबर से जवाब दें:\n1. तुरंत\n2. 3 महीने में\n3. 6 महीने में\n4. अभी सिर्फ देख रहे हैं',
    budget: 'धन्यवाद। आपका अनुमानित बजट क्या है? जैसे: 90 lakh या 1.2 crore।',
    visit: 'क्या आप साइट देखना चाहेंगे? हाँ के लिए 1 और नहीं के लिए 2 लिखें।',
    fix: 'धन्यवाद। हमारी टीम समय तय करने के लिए आपको कॉल करेगी।',
    handover: 'धन्यवाद। हमारी टीम जल्द ही आपसे संपर्क करेगी।',
    missed: 'माफ़ कीजिए, मैं समझ नहीं पाया।',
  },
  mr: {
    project: 'तुम्हाला कोणत्या प्रकल्पात रस आहे? कृपया क्रमांकाने उत्तर द्या:',
    notSure: 'अजून ठरले नाही',
    help: 'आमच्या टीमशी बोलण्यासाठी AGENT लिहा. संदेश थांबवण्यासाठी STOP लिहा.',
    size: 'तुम्हाला कोणते घर हवे आहे? उदा: Studio, 1 BHK किंवा 2 BHK.',
    available: 'उपलब्ध',
    from: 'सुरुवातीची किंमत',
    brochure: 'ब्रोशर',
    when: 'तुम्ही कधी खरेदी करण्याचा विचार करत आहात? कृपया क्रमांकाने उत्तर द्या:\n1. लगेच\n2. 3 महिन्यांत\n3. 6 महिन्यांत\n4. सध्या फक्त पाहत आहे',
    budget: 'धन्यवाद. तुमचे अंदाजे बजेट किती आहे? उदा: 90 lakh किंवा 1.2 crore.',
    visit: 'तुम्हाला साइटला भेट द्यायची आहे का? होयसाठी 1 आणि नाहीसाठी 2 लिहा.',
    fix: 'धन्यवाद. योग्य वेळ ठरवण्यासाठी आमची टीम तुम्हाला कॉल करेल.',
    handover: 'धन्यवाद. आमची टीम लवकरच तुमच्याशी संपर्क करेल.',
    missed: 'क्षमस्व, मला समजले नाही.',
  },
};

const price = (p: BotProject) => {
  if (!p.price_from_lakhs) return '';
  return p.price_from_lakhs >= 100 ? `₹${(p.price_from_lakhs / 100).toFixed(2)} Cr` : `₹${p.price_from_lakhs} Lakhs`;
};

const projectMenu = (projects: BotProject[], t: Record<string, string>) =>
  [...projects.map((p, i) => `${i + 1}. ${p.name}, ${p.location}`), `0. ${t.notSure}`].join('\n');

const projectQuestion = (projects: BotProject[], t: Record<string, string>) => `${t.project}\n${projectMenu(projects, t)}\n\n${t.help}`;

export const BOT_GREETING = `Namaste! Welcome to Archstone. I am the automated assistant.

Please choose your language:
भाषा चुनें / भाषा निवडा:
1. English
2. हिंदी
3. मराठी`;

/** Reads "90", "90 lakh", "1.2 cr" or "₹1,20,00,000" as lakhs. */
export function parseBudget(text: string): number | null {
  const clean = text.toLowerCase().replace(/[,₹\s]/g, '').replace('लाख', 'lakh').replace('करोड़', 'cr').replace('कोटी', 'cr');
  const match = clean.match(/^(\d+(?:\.\d+)?)(cr|crore|crores|l|lac|lacs|lakh|lakhs)?$/);
  if (!match) return null;
  const value = Number(match[1]);
  if (match[2]?.startsWith('c')) return value * 100;
  if (match[2]) return value;
  if (value >= 100000) return value / 100000; // Full rupee amount.
  return value;
}

export function botStep(state: string, tries: number, text: string, projects: BotProject[], language: BotLanguage = 'en'): BotStep {
  const said = text.trim();
  const lower = said.toLowerCase();
  const t = TEXT[language];

  if (HUMAN_WORDS.some((w) => lower.includes(w))) {
    return { reply: t.handover, state: 'done', tries: 0, handover: true };
  }
  const retry = (question: string): BotStep =>
    tries + 1 >= MAX_TRIES
      ? { reply: `${t.missed} ${t.handover}`, state: 'done', tries: 0, handover: true }
      : { reply: `${t.missed}\n\n${question}`, state, tries: tries + 1 };

  switch (state) {
    case 'language': {
      const chosen = ({ '1': 'en', '2': 'hi', '3': 'mr', english: 'en', hindi: 'hi', marathi: 'mr', 'हिंदी': 'hi', 'मराठी': 'mr' } as Record<string, BotLanguage>)[lower];
      if (!chosen) return retry('1. English\n2. हिंदी\n3. मराठी');
      return { reply: projectQuestion(projects, TEXT[chosen]), state: 'project', tries: 0, language: chosen };
    }
    case 'project': {
      if (said === '0') return { reply: t.size, state: 'configuration', tries: 0, save: { project_id: null } };
      const project = projects[Number(said) - 1];
      if (!/^\d+$/.test(said) || !project) return retry(`${t.project}\n${projectMenu(projects, t)}`);
      const from = price(project);
      const details = [
        `${project.name}, ${project.location}.`,
        project.configuration ? `${t.available}: ${project.configuration}.` : '',
        from ? `${t.from}: ${from}.` : '',
        project.brochure_url ? `${t.brochure}: ${project.brochure_url}` : '',
      ].filter(Boolean).join(' ');
      return { reply: `${details}\n\n${t.size}`, state: 'configuration', tries: 0, save: { project_id: project.id } };
    }
    case 'configuration': {
      if (said.length < 1 || said.length > 40) return retry(t.size);
      return { reply: t.when, state: 'timeline', tries: 0, save: { configuration: said } };
    }
    case 'timeline': {
      const timeline = TIMELINES[Number(said) - 1];
      if (!timeline) return retry(t.when);
      return { reply: t.budget, state: 'budget', tries: 0, save: { timeline } };
    }
    case 'budget': {
      const budget = parseBudget(said);
      if (!budget) return retry(t.budget);
      return { reply: t.visit, state: 'visit', tries: 0, save: { budget_lakhs: budget } };
    }
    case 'visit': {
      if (!['1', '2', 'yes', 'no', 'हाँ', 'नहीं', 'होय', 'नाही'].includes(lower)) return retry(t.visit);
      const wantsVisit = ['1', 'yes', 'हाँ', 'होय'].includes(lower);
      return { reply: wantsVisit ? t.fix : t.handover, state: 'done', tries: 0, wantsVisit, finished: true };
    }
    default:
      return { reply: t.handover, state: 'done', tries: 0, handover: true };
  }
}
