import { all } from '../db.ts';

interface Requirement { budget_lakhs: number | null; configuration: string; preferred_location: string; project_id: number | null }
interface Unit { id: number; project_id: number; tower: string; number: string; floor: number; configuration: string; price_lakhs: number; project_name: string; location: string; carpet_sqft: number | null }

const bedrooms = (text: string) => text.match(/\d+(\.\d+)?/)?.[0] ?? '';

/** Scores one home for one buyer. A home over budget or of the wrong size never matches. */
export function scoreHome(lead: Requirement, unit: Unit) {
  if (!lead.budget_lakhs && !lead.configuration) return null;
  const reasons: string[] = [];
  let score = 0;

  if (lead.budget_lakhs) {
    if (unit.price_lakhs > lead.budget_lakhs * 1.1) return null;
    if (unit.price_lakhs <= lead.budget_lakhs) { score += 50; reasons.push('Within budget'); } else { score += 35; reasons.push('Slightly over budget'); }
  } else score += 25;

  const wanted = bedrooms(lead.configuration);
  if (wanted) {
    if (bedrooms(unit.configuration) !== wanted) return null;
    score += 30;
    reasons.push(`${wanted} BHK`);
  } else score += 15;

  const place = lead.preferred_location.trim().toLowerCase();
  if (place && unit.location.toLowerCase().includes(place)) { score += 10; reasons.push('Preferred location'); }
  if (lead.project_id === unit.project_id) { score += 10; reasons.push('Project they asked about'); }
  return { score: Math.min(100, score), reasons };
}

const availableUnits = (projectId?: number) => all<Unit>(
  `SELECT u.id, u.project_id, u.tower, u.number, u.floor, u.configuration, u.price_lakhs, u.carpet_sqft, p.name AS project_name, p.location
   FROM units u JOIN projects p ON p.id = u.project_id
   WHERE u.status = 'Available' AND u.price_lakhs IS NOT NULL ${projectId ? 'AND u.project_id = ?' : ''}`,
  ...(projectId ? [projectId] : []),
);

export function homesFor(lead: Requirement, limit = 6) {
  const scored = availableUnits()
    .map((unit) => ({ unit, match: scoreHome(lead, unit) }))
    .filter((x) => x.match)
    .map(({ unit, match }) => ({ ...unit, score: match!.score, reasons: match!.reasons }))
    .sort((a, b) => b.score - a.score || a.price_lakhs - b.price_lakhs);
  // One line per project, tower and size, so 40 identical flats do not fill the list.
  const seen = new Set<string>();
  const distinct = scored.filter((u) => {
    const key = `${u.project_id}|${u.tower}|${u.configuration}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { homes: distinct.slice(0, limit), total: scored.length };
}

/** Open leads a project could suit. The caller's lead scope limits who appears. */
export function buyersFor(projectId: number, scope: { sql: string; params: (string | number)[] }) {
  const units = availableUnits(projectId);
  const leads = all<Requirement & { id: number; name: string; temperature: string; stage: string; score: number; owner_name: string | null }>(
    `SELECT l.id, l.name, l.temperature, l.stage, l.score, l.budget_lakhs, l.configuration, l.preferred_location, l.project_id, u.name AS owner_name
     FROM leads l LEFT JOIN users u ON u.id = l.owner_id
     WHERE ${scope.sql} AND l.stage NOT IN ('Booked','Lost','Unqualified') AND l.do_not_contact = 0`,
    ...scope.params,
  );
  return leads
    .map((lead) => {
      const best = units.map((unit) => ({ unit, match: scoreHome(lead, unit) })).filter((x) => x.match).sort((a, b) => b.match!.score - a.match!.score)[0];
      return best ? { id: lead.id, name: lead.name, temperature: lead.temperature, stage: lead.stage, owner_name: lead.owner_name, match: best.match!.score, reasons: best.match!.reasons } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b!.match - a!.match)
    .slice(0, 50);
}
