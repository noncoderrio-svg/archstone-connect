// Rules the AI team cannot talk its way around. They run in code on every plan,
// after the model has answered, so a clever prompt or a careless draft changes nothing.

/** Words that select or exclude people by who they are. Housing ads must never do this. */
const PROTECTED = /\b(hindu|muslim|islam|christian|sikh|jain|parsi|buddhis|brahmin|maratha|dalit|caste|religio|community only|vegetarian(s)? only|veg only|bachelor|married|single (men|women)|men only|women only|male|female|gender|pregnan|disab|handicap|senior citizens? only|nationalit|ethnic|race\b|skin|lgbt|gay|income (group|bracket)|pin ?code|zip)\b/i;

/** Promises an advertiser of homes must not make (MahaRERA, ASCI, Meta). */
const BANNED_COPY: [RegExp, string][] = [
  [/\b(guarantee[ds]?|assured|sure[- ]shot|risk[- ]free)\b[^.]{0,40}\b(return|rental|appreciation|profit|income|yield)/i, 'promises a guaranteed return'],
  [/\b(double|triple) your (money|investment)\b/i, 'promises to multiply money'],
  [/\b\d{1,3}\s?% (assured|guaranteed)\b/i, 'promises a guaranteed percentage'],
  [/\b(no\.?\s?1|number one|best in (mumbai|india|thane|pune)|cheapest|lowest price)\b/i, 'makes a superlative claim that needs proof'],
  [/\b(only \d+ (flats|units|homes) left|last \d+ (flats|units))\b/i, 'claims scarcity that must match real stock'],
  [/\b(are you|you are|your) (a |an )?(muslim|hindu|christian|jain|sikh|single|divorced|pregnant|in debt)\b/i, 'speaks about a personal attribute of the reader'],
];

export interface Issue { level: 'blocked' | 'fixed' | 'warning'; text: string }

export interface Targeting { countries: string[]; center: string; radius_km: number; age_min: number; age_max: number; genders: 'all'; interests: string[] }

/**
 * Housing-safe targeting whatever the agents proposed: everyone aged 18 to 65+,
 * all genders, a radius of at least 25 km (Meta's housing floor is 15 miles), and
 * interests about property only. Nothing based on who a person is.
 */
export function safeTargeting(input: { center: string; radius_km?: number; interests?: string[] }): { targeting: Targeting; issues: Issue[] } {
  const issues: Issue[] = [];
  const radius = Math.round(input.radius_km ?? 25);
  if (radius < 25) issues.push({ level: 'fixed', text: `Radius widened from ${radius} km to 25 km, the smallest area housing ads may use.` });
  const interests: string[] = [];
  for (const raw of input.interests ?? []) {
    const interest = raw.trim().slice(0, 60);
    if (!interest) continue;
    if (PROTECTED.test(interest)) issues.push({ level: 'fixed', text: `Removed the interest "${interest}", because it selects people by who they are.` });
    else if (!interests.includes(interest)) interests.push(interest);
  }
  return {
    targeting: { countries: ['IN'], center: input.center, radius_km: Math.min(80, Math.max(25, radius)), age_min: 18, age_max: 65, genders: 'all', interests: interests.slice(0, 12) },
    issues,
  };
}

/** Checks one piece of ad copy. A project without a MahaRERA number cannot be advertised at all. */
export function checkCopy(text: string, where: string, rera: string): Issue[] {
  const issues: Issue[] = [];
  for (const [pattern, why] of BANNED_COPY) if (pattern.test(text)) issues.push({ level: 'blocked', text: `${where}: ${why}.` });
  if (PROTECTED.test(text)) issues.push({ level: 'blocked', text: `${where}: mentions a personal attribute such as religion, gender or family status.` });
  if (rera && where.includes('primary text') && !text.includes(rera)) issues.push({ level: 'blocked', text: `${where}: the MahaRERA number is missing.` });
  return issues;
}

/** Makes sure the MahaRERA line is in the text people read, even if the model forgot it. */
export function withRera(text: string, rera: string) {
  if (!rera || text.includes(rera)) return text;
  return `${text.trim()}\n\nMahaRERA No: ${rera} | maharera.maharashtra.gov.in`;
}

/** MahaRERA's 2025 circular: these three must be clear, in the top-right of every ad image, as large as the biggest contact detail. */
export const IMAGE_RULE = 'Every ad image or video must show the MahaRERA number, maharera.maharashtra.gov.in and the project QR code, clearly, in the top-right corner.';

export const blocked = (issues: Issue[]) => issues.some((i) => i.level === 'blocked');
