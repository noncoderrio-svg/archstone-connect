// What every agent knows about selling homes in Mumbai and around it, before it reads a brief.
// This is background for thinking. Ad copy still uses only the project's own verified facts.
import { getSetting } from '../../db.ts';
import { HOUSE_RULES } from './agents.ts';

export const MARKET_KNOWLEDGE = `BACKGROUND KNOWLEDGE (general, may be out of date; use it to reason and to ask better questions, never state it in an ad as a fact about this project. Anything specific, such as a rate, a date or a distance, goes in "questions for the owner" to verify.)

Market shape: Mumbai Metropolitan Region (MMR)
- Mumbai city and suburbs: South Mumbai, Worli and Lower Parel (luxury, redevelopment); Bandra to Andheri (premium western suburbs); Goregaon, Malad, Kandivali, Borivali (mid to upper-mid family market); Powai, Chembur, Ghatkopar, Mulund (central and eastern suburbs, upgraders).
- Thane: Ghodbunder Road, Majiwada, Kolshet. Large townships, families upgrading from 1 BHK to 2 BHK, buyers priced out of the suburbs.
- Navi Mumbai: Vashi, Sanpada, Nerul, Seawoods, Belapur (established, planned nodes); Kharghar, Airoli, Ghansoli, Kopar Khairane (IT and education catchment); Panvel, Ulwe, Dronagiri, Taloja (growth belt, more affordable, investor interest tied to the airport and the Atal Setu sea link).
- Beyond: Mira Road and Bhayandar, Vasai and Virar, Kalyan and Dombivli, Badlapur, Karjat (affordable and first-home markets; second homes further out).
- Buyers think in micro-markets and commute time, not in city names. Station or metro distance, school access and the daily commute decide more enquiries than amenities do.

Navi Mumbai specifics
- Much land is CIDCO leasehold; buyers ask about CIDCO transfer charges, the 12.5% scheme, and whether a project falls under NMMC, Panvel (PMC) or NAINA. Never guess: ask the owner.
- Demand drivers people respond to: Navi Mumbai International Airport, Atal Setu (the trans-harbour link), Navi Mumbai Metro, the Sion to Panvel and Mumbai to Pune corridors, IT parks in Airoli, Ghansoli and Mahape, and JNPT for Ulwe and Dronagiri.
- Planned nodes, wider roads and open space are the usual reasons families choose it over the suburbs.

Who buys, by need (never by identity)
- First home buyer moving from rent: cares about EMI against rent, down payment, loan eligibility, possession date.
- Family upgrading: needs a bigger home near the same schools and relatives; often must sell first.
- Investor: looks at entry price, rental demand, infrastructure timelines, developer record. We never promise returns.
- NRI buyer (Gulf, US, UK, Singapore): wants trust, clear paperwork, virtual tours, a single point of contact; pays through NRE or NRO accounts; cannot buy agricultural land. Ads shown in the US, Canada or Europe must be declared as housing ads to Meta.
- Buyer in a redevelopment or resale chain: timing and rent compensation matter.

Words buyers and the sales team use
- BHK, 1.5 BHK and "Jodi" flats; carpet area as defined by RERA (the only area that may be advertised), against built-up and super built-up.
- OC (occupancy certificate) and CC (commencement certificate); "ready to move" against under construction; possession date as registered with MahaRERA.
- All-inclusive price: agreement value plus stamp duty, registration, GST on under-construction homes, and other charges. Buyers distrust "starting from" prices that hide these. Quote only what the project record holds.
- Payment plans: construction-linked (CLP), subvention and "pay later" schemes only when the owner confirms one is running.
- Home loan steps: sanction, disbursement in stages, pre-EMI against full EMI. Loan help is a strong, honest hook.
- Floor rise, parking, maintenance deposit, society formation, Vastu, and view or direction premiums are common questions.

Objections to prepare for
- "Is the price final?", hidden charges, delay in possession, developer reputation, water supply and traffic, distance to station, resale and rental demand, "I will decide after a site visit".
- The best answer to most of them is a site visit, a cost sheet, and the MahaRERA record.

Law and rules for advertising here
- MahaRERA: every advertisement carries the registration number, maharera.maharashtra.gov.in and the project QR code, prominently (top-right, as large as the largest contact detail). Agents and mandate firms are covered too. Only registered projects may be advertised. Advertise carpet area only. Amenities shown must be the sanctioned ones.
- ASCI: claims must be provable; no misleading "starting" prices; disclaimers must be readable.
- Never promise returns, appreciation or rental yield. No "last few units" unless stock proves it.
- WhatsApp and calls only to people who agreed, and honour opt-outs.

When people buy
- Auspicious periods lift enquiries and bookings: Gudi Padwa, Akshaya Tritiya, Ganesh Chaturthi, Navratri and Dussehra, Dhanteras and Diwali. Plan launches and offers 3 to 4 weeks ahead. Pitru Paksha is usually quiet for bookings but fine for awareness.
- Financial year end (January to March) brings tax-driven buying and developer targets. Monsoon slows site visits, so use virtual tours and pickup offers.
- Enquiries peak on evenings and weekends; site visits on Saturday and Sunday.

What works in real estate lead generation (India and international practice)
- Speed to lead: a call within 5 minutes converts several times better than one after an hour. Judge campaigns by cost per qualified lead, per site visit and per booking, not by cost per lead.
- Instant forms give volume; add 2 to 3 qualifying questions (home size, budget band, timeline) or use the higher-intent form to protect quality. Click-to-WhatsApp gives fewer, warmer leads.
- Creative decides most of the result. Real photos and walkthrough reels beat renders and stock images. One clear message per ad: location, price band, or a site visit invitation. The first 2 seconds of a reel must name the place or the buyer's problem.
- Test 3 to 5 angles at once (location, own-versus-rent, connectivity, family space, site visit), keep the winners, and refresh creatives every 2 to 3 weeks before fatigue shows as rising cost and falling click rate.
- Give a new ad set about a week and roughly 50 leads before judging it. Change budgets by at most 20% at a time. Avoid many small ad sets that split a small budget.
- Send lead outcomes back to Meta (the CRM's Meta feedback) so it looks for buyers, not form-fillers.
- Mumbai region buyers read English, Hindi and Marathi; offer creatives in the language of the locality's media, without ever targeting or excluding people by language or community.
- Remarket to people who watched a reel or opened a form with a site-visit invitation.
- Trust signals that are honest: MahaRERA number, developer's delivered projects, bank approvals, construction progress photos with dates.`;

/** The owner's own verified notes: developer record, standing offers, brand voice. Added to every agent's instructions. */
export const companyNotes = () => getSetting<string>('mkt_company_notes', '');

/** Instructions every agent starts with. The fixed part comes first so the model provider can cache it. */
export function systemPrompt() {
  const notes = companyNotes().trim();
  return `${HOUSE_RULES}\n\n${MARKET_KNOWLEDGE}${notes ? `\n\nCOMPANY NOTES (verified by the owner; these may be used as facts)\n<data>${notes}</data>` : ''}`;
}
