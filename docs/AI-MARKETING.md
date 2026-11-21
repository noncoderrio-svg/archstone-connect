# AI marketing team: architecture, status and plan

Written 21 November 2026. Branch: `ai-marketing-department`. Nothing here has been deployed to the live server.

## 1. What your CRM already is

Archstone Connect is one program: a TypeScript server (Express) with a SQLite database, and a React web app. It runs in Docker on your VPS, with all data on the `/data` disk. An Android app opens the same site.

| Area | What exists | State |
| --- | --- | --- |
| Leads | Website, Meta Lead Ads, Google Ads, 99acres, MagicBricks, Housing.com, sheets, manual | Built and tested with fake servers |
| Meta lead forms | Instant webhook, plus a pull every 15 minutes for anything missed | Built. No page is connected on this laptop's copy |
| Meta feedback | Sends lead outcomes back to Meta (Conversions API for CRM) | Built, off until you add a Dataset ID |
| Assignment | Lead Routing by campaign, ad set, ad, form or source; duty-aware | Built |
| Follow-ups | Reminders, overdue alerts, escalation to managers, morning summary | Built |
| WhatsApp | Cloud API inboxes, templates, broadcasts with consent and MahaRERA checks | Built |
| AI | Gemini: lead summaries, reply drafts, report questions | Built, needs a key |
| Reports | Funnel, sources, team, daily and weekly by email or WhatsApp | Built. Ad spend was typed in by hand |
| Security | Roles and permissions, two-factor for admins, encrypted keys, audit log, daily backups | Built |

### What was missing for marketing

1. No connection to Meta Ads Manager: the CRM could receive leads but could not read spend, CPM, CTR or CPL, or create a campaign.
2. No campaign planning, ad writing or creative briefs.
3. No cost per qualified lead or per booking, because spend was not joined to lead outcomes.
4. No approval step for advertising actions.
5. No n8n connection.

### Two things to fix on the live server

- **Meta API version.** The CRM's default is `v21.0`, which Meta has retired. Meta's current version is v27.0 (released 4 November 2026). In Settings → Integrations → WhatsApp Cloud API, set **Meta API version** to `v27.0`, then test that leads and WhatsApp still flow. The new ads connection already uses v27.0.
- **Test each connection against the real service.** The README says the same: Meta, Exotel, Google and Gemini were tested with fake servers only.

## 2. The team

Eight agents, each with one job and a fixed answer format. They sit inside the CRM, so they see your real projects and leads and obey your existing permissions.

| # | Agent | Thinks with | Does | May act alone? |
| --- | --- | --- | --- | --- |
| 1 | Marketing Director | Claude | Strategy, budget split, risks, questions for you; answers your questions | Yes: drafts only |
| 2 | Audience Research | Gemini | Buyer personas by need, location and radius, property interests | Yes: drafts only |
| 3 | Meta Ads Strategist | Claude | Objective, ad sets, placements, lead form questions | Yes: drafts only |
| 4 | Creative | Claude | Headlines, ad text, hooks, reel script, video brief, Canva brief | Yes: drafts only |
| 5 | Campaign Builder | Fixed rules, no AI | Assembles the campaign, runs compliance checks, creates it in Meta as PAUSED | Only after your approval |
| 6 | Performance Analyst | Gemini | Reads CPM, CTR, CPC, CPL and lead quality; names strong and weak campaigns | Yes: reading only |
| 7 | Optimization | Claude | Suggests pause, budget change or new creative, with evidence and risk | No: every suggestion waits |
| 8 | Reporting | Gemini | Daily, weekly and monthly Director's report with the top 3 priorities | Yes: reports only |

If only one AI key is set, every agent uses that one. With no key, demo mode shows sample answers marked **Simulated**; a live system shows a clear "AI is not connected" message instead.

```
You write a brief (project, goal, budget, days)
        │
        ▼
Director → Audience → Strategist → Creative → Campaign Builder
                                                   │  compliance checks in code
                                                   ▼
                                         Draft + "Create in Meta, paused"  ──► you approve
                                                   ▼
                                         Campaign exists in Meta, PAUSED (₹0)
                                                   ▼
                                         "Switch on" request  ──► you approve (cost shown)
                                                   ▼
Meta results (hourly) + CRM lead outcomes ──► Analyst → Optimization ──► suggestions wait for you
                                                   ▼
                                         Reporting → daily / weekly / monthly report → app, n8n
```

### Rules the agents cannot break

These run in code after the AI answers, so a prompt cannot change them:

- Every campaign is created **PAUSED**. Switching on is a separate approval that shows the total cost.
- The team may divide your budget, never raise it. A budget increase is at most 20% at a time and needs approval.
- Targeting is always everyone aged 18 to 65+, all genders, 25 km or wider, property interests only. Interests about religion, caste, community, gender, family status or income are removed.
- Ad text is blocked if it promises returns, makes unprovable claims, invents scarcity, or mentions a personal attribute.
- A project with no MahaRERA number cannot be advertised. The number is added to every ad text.
- Every draft reminds you that images need the MahaRERA number, website and QR code in the top-right corner.
- Figures (spend, CPL, cost per booking) are calculated by the CRM. The AI only explains them.
- An approval runs once, exactly as approved, and is written to the audit log with who approved it.
- n8n can ask for reports. It can never approve or change a campaign.

Campaigns are declared to Meta as **housing ads**. Meta does not require this in India, but it makes Meta enforce the same open-to-everyone rules. The cost is that lookalike audiences are unavailable. This can be changed later if you prefer reach over the safeguard.

### What the agents know

Every agent starts with a built-in knowledge pack: the Mumbai region's micro-markets (Mumbai, Thane, Navi Mumbai nodes, the outer belt), buyer types by need, the words buyers use, common objections, MahaRERA and ASCI advertising rules, buying seasons, NRI buyers, and proven lead generation practice. It is used for thinking. Ads state only facts from your project records and your own notes. Add your verified notes under **Marketing AI → Knowledge**.

## 3. Where it lives in the code

| File | Purpose |
| --- | --- |
| `server/services/marketing/agents.ts` | The eight agents: instructions, answer formats, sample answers |
| `server/services/marketing/knowledge.ts` | Market knowledge and your company notes |
| `server/services/marketing/llm.ts` | Claude (official SDK) and Gemini, answers checked against a format |
| `server/services/marketing/compliance.ts` | Targeting and ad text rules |
| `server/services/marketing/metaAds.ts` | Meta Marketing API: results, create paused, switch, budget |
| `server/services/marketing/pipeline.ts` | Runs the team, approvals, results, reports, schedule |
| `server/routes/marketing.ts` | The API behind the screen |
| `web/src/pages/Marketing.tsx` | The **Marketing AI** screen |
| `n8n/*.json` | Three workflows to import |
| `tests/marketing.test.ts` | Eight tests of the rules above |

New database tables all start with `mkt_`. No existing table or screen was changed, apart from adding the menu entry, two permissions, one feature switch and three connections.

## 4. What is verified, and what is not

**Verified on this laptop**

- The whole flow in the browser, on a throwaway database: brief → draft → approval → simulated campaign → results → review → report.
- Automated tests, with Meta replaced by a fake server: everything is created PAUSED, the housing declaration is sent, targeting is safe, the token never appears in a request body, going live needs its own approval, and n8n cannot approve.

**Not verified yet**

- **Real Meta Ads Manager.** No token was available. Meta's exact field requirements can only be confirmed against your account. Use **Test Meta safely** first; it only reads.
- **Real Claude and Gemini answers.** No key was set here, so only sample answers were seen.
- **n8n workflows.** The files follow n8n's format but have not been imported into your n8n.
- **Creating the ads themselves in Meta.** Version 1 creates the campaign and ad sets. Images, videos and the lead form are added in Ads Manager, because they need your designed creatives. The ad text is ready to copy from the draft.

## 5. Tools: who does what

| Tool | Role |
| --- | --- |
| Claude | Director, Strategist, Creative, Optimization |
| Gemini | Audience Research, Analyst, Reporting; existing lead summaries and replies |
| Canva | Your designer follows the Canva brief in each draft. Automatic fill of brand templates is possible through Canva's Connect API; next phase |
| Adobe | Your editor follows the video brief and reel script. Adobe's automation API is still beta and not for commercial output |
| n8n | Optional scheduler and messenger: daily report, weekly review, team notifications |
| Meta Ads | Where campaigns run. Reached only through approved actions |
| CRM | The centre: data, rules, approvals, audit log |

Lead capture, assignment, follow-up reminders and missed follow-up alerts stay inside the CRM. They already work there, and moving them to n8n would add a second place for them to fail.

## 6. Setting it up

1. **Settings → Features**: switch on **AI marketing team**.
2. **Settings → Integrations → Gemini AI** and/or **Claude AI**: add a key.
3. **Settings → Integrations → Meta Ads Manager**: add a System User token (from Meta Business Settings, with `ads_read` and `ads_management` on your ad account), the ad account ID and the Facebook Page ID. For your own ad account, Meta's standard access is enough; no app review is needed.
4. **Marketing AI → Team → Test Meta safely.** It reads the account name and permissions, and changes nothing.
5. Add each project's MahaRERA number under Projects.
6. Write a brief. Review the draft. Approve "Create in Meta, paused". Check it in Ads Manager, add images and the lead form, then ask to switch on.
7. Optional n8n: generate an **Automation key** under Integrations → n8n automation. In n8n, create a "Header Auth" credential named `Archstone CRM automation key` with header `X-Api-Key`, import the three files from `n8n/`, and replace `YOUR-CRM-ADDRESS`. On Coolify, set `N8N_ENCRYPTION_KEY` yourself and keep `/home/node/.n8n` on a permanent volume, or n8n loses its saved credentials on a restart.

## 7. Phases

| Phase | Content | Status |
| --- | --- | --- |
| 1 | Eight agents, compliance rules, approvals, results, reports, knowledge, n8n hook, screen, tests | Built, tested locally |
| 2 | Connect real keys on a staging copy; confirm Meta fields against your account; first real paused campaign | Needs your keys |
| 3 | Deploy to the live server after your approval; update Meta API version | Needs your approval |
| 4 | Create ads in Meta from Property Files images and your lead form; creative-level results (best and worst ad) | Next |
| 5 | Marketing task board for the designer, editor and social media manager; human handover tasks from AI chats | Next |
| 6 | Canva template autofill; click-to-WhatsApp campaigns; budget reallocation between campaigns | Later |

## 8. Sources checked on 21 November 2026

- Meta Marketing API changelog and versions: developers.facebook.com/docs/marketing-api/marketing-api-changelog
- Special ad categories: developers.facebook.com/docs/marketing-api/audiences/special-ad-category
- Authorization and system users: developers.facebook.com/docs/marketing-api/overview/authorization
- Conversion leads: developers.facebook.com/docs/marketing-api/conversions-api/conversion-leads-integration
- Approval pattern studied: github.com/langchain-ai/paid-media-agent. Tool design studied: github.com/pipeboard-co/meta-ads-mcp. No code was copied from either.
- MahaRERA QR code and prominence rules were read from secondary reports (TaxGuru, Housing.com, Free Press Journal, LiveLaw), not from MahaRERA's own PDFs. Confirm with your compliance adviser.
