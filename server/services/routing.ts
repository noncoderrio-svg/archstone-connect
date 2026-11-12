import { all, get, nowIso, run } from '../db.ts';

/** Decides who gets a lead, from the campaign, ad set, ad or form it came through. */
export interface RouteInput {
  source?: string;
  utm_campaign?: string;
  adset?: string;
  ad?: string;
  form_name?: string;
}

export interface Route {
  id: number; name: string; priority: number; match_source: string; match_campaign: string; match_adset: string;
  match_ad: string; match_form: string; project_id: number | null; user_ids: string; mode: string; next_index: number;
}

const contains = (value: string | undefined, wanted: string) => !wanted || (value ?? '').toLowerCase().includes(wanted.toLowerCase());

export const routeMatches = (route: Route, lead: RouteInput) =>
  contains(lead.source, route.match_source)
  && contains(lead.utm_campaign, route.match_campaign)
  && contains(lead.adset, route.match_adset)
  && contains(lead.ad, route.match_ad)
  && contains(lead.form_name, route.match_form);

/** The first rule that fits wins, so a narrow rule can sit above a broad one. */
export function matchRoute(lead: RouteInput) {
  return all<Route>('SELECT * FROM lead_routes WHERE enabled = 1 ORDER BY priority, id').find((route) => routeMatches(route, lead));
}

const openLeads = (userId: number) =>
  get<{ n: number }>(`SELECT COUNT(*) n FROM leads WHERE owner_id = ? AND deleted_at IS NULL AND stage NOT IN ('Booked','Lost','Unqualified')`, userId)!.n;

/** Takes turns, or picks the lightest load. A paused person is skipped, and their turn passes on. */
export function nextFromRoute(route: Route) {
  const members = (JSON.parse(route.user_ids) as number[])
    .map((id) => get<{ id: number; role: string }>(`SELECT id, role FROM users WHERE id = ? AND status = 'active'`, id))
    .filter((u): u is { id: number; role: string } => Boolean(u));
  if (!members.length) return null;
  if (route.mode === 'workload') return [...members].sort((a, b) => openLeads(a.id) - openLeads(b.id))[0];
  const person = members[route.next_index % members.length];
  run('UPDATE lead_routes SET next_index = ?, last_used_at = ? WHERE id = ?', (route.next_index + 1) % Math.max(members.length, 1), nowIso(), route.id);
  return person;
}
