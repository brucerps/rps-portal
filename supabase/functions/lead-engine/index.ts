// Supabase Edge Function: lead-engine
// Every morning (pg_cron, every 5 min 07:00–09:12 IST) it finds businesses in South India with a live need for
// marketing, checks each one, adds the ones that pass to the CRM (already verified), and emails the founder by 9:15.
// Secrets (Supabase → Edge Functions → Secrets): ANTHROPIC_API_KEY (required), RESEND_API_KEY (for the email).
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const PORTAL = "https://brucerps.github.io/rps-portal/";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const pick = (n: string) => { try { const o = JSON.parse(Deno.env.get(n) ?? "{}"); return (o.default ?? Object.values(o)[0]) as string | undefined; } catch { return undefined; } };
const ist = () => { const d = new Date(Date.now() + 330 * 60000); return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() }; };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const BLOCKS_BOTS = /(^|\.)(linkedin\.com|instagram\.com|facebook\.com|naukri\.com|indeed\.com|x\.com|twitter\.com|glassdoor\.co\.in|glassdoor\.com|apna\.co|foundit\.in|instahyre\.com|justdial\.com)$/i;
const AGENCY = /\b(digital marketing|marketing agency|advertising agency|ad agency|media agency|social media agency|branding agency|creative agency|seo (services|company|agency)|pr agency|influencer agency|marketing solutions|media house)\b/i;

type Lead = Record<string, any>;
type Cfg = { active: boolean; daily_target: number; report_email: string; model: string; plan: any[]; allowed_states: string[]; services: string[] };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = Deno.env.get("SUPABASE_URL")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || pick("SUPABASE_SECRET_KEYS")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || pick("SUPABASE_PUBLISHABLE_KEYS")!;
  const db = createClient(url, service, { auth: { persistSession: false } });
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* cron sends {} */ }

  // A manual run ("force") is only for the founder: checked against the database with their own login.
  let force = false;
  if (body.force) {
    const caller = createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    force = (await caller.rpc("is_admin")).data === true;
    if (!force) return json(403, { error: "Only the founder can run the lead engine by hand." });
  }

  const cfg = (await db.from("lead_engine_config").select("*").single()).data as Cfg | null;
  if (!cfg?.active) return json(200, { idle: "The lead engine is switched off." });
  const t = ist();
  if (!force && (t.min < 7 * 60 || t.min > 9 * 60 + 12)) return json(200, { idle: "Outside the morning window (07:00–09:12 IST)." });

  const work = step(db, cfg, t, force);
  if (force) return json(200, await work);                                   // manual: wait for the result
  // @ts-ignore EdgeRuntime is provided by Supabase
  EdgeRuntime.waitUntil(work.catch((e: Error) => console.error("lead-engine", e)));  // cron: answer at once, keep working
  return json(202, { started: true });
});

async function addedToday(db: any): Promise<Lead[]> {
  const src = (await db.from("lead_sources").select("id").eq("source_name", "RPS Lead Engine (daily)").single()).data;
  const t = ist(), from = new Date(`${t.date}T00:00:00+05:30`).toISOString();
  return (await db.from("leads").select("lead_code,status,source_reference,status_reason,company:companies(name,city,state,website,industry),contact:contacts(full_name,designation,phone_e164,email),owner:profiles!leads_assigned_to_fkey(full_name)")
    .eq("source_id", src.id).gte("created_at", from).order("created_at")).data ?? [];
}

async function step(db: any, cfg: Cfg, t: { date: string; min: number }, force: boolean) {
  const have = (await addedToday(db)).length;
  const rep = (await db.from("lead_engine_reports").select("*").eq("run_date", t.date).maybeSingle()).data;
  const reportTime = t.min >= 9 * 60;
  if ((have >= cfg.daily_target || reportTime) && !force) {
    if (!rep?.emailed_at) return await sendReport(db, cfg, t.date);
    return { done: true, added: have };
  }
  let batch = (await db.rpc("engine_claim_batch")).data;
  if (!batch?.batch_no) {
    // planned batches are finished but we are short: top up with more Bengaluru batches until 08:50
    const { count } = await db.from("lead_engine_runs").select("batch_no", { count: "exact", head: true }).eq("run_date", t.date).gte("batch_no", 100);
    if (have < cfg.daily_target && (count ?? 0) < 6 && (t.min < 8 * 60 + 50 || force)) {
      await db.from("lead_engine_runs").insert({ run_date: t.date, batch_no: 100 + (count ?? 0), region: "Bengaluru", want: Math.min(5, cfg.daily_target - have) });
      batch = (await db.rpc("engine_claim_batch")).data;
    }
  }
  if (!batch?.batch_no) {
    if (!rep?.emailed_at && (reportTime || have >= cfg.daily_target || force)) return await sendReport(db, cfg, t.date);
    return { idle: "Nothing to do right now.", added: have };
  }
  return await runBatch(db, cfg, batch, have);
}

async function runBatch(db: any, cfg: Cfg, batch: any, have: number) {
  const plan = cfg.plan.find((p: any) => p.region === batch.region) ?? { region: batch.region, state: "Karnataka", focus: "any business with a fresh, visible need for marketing" };
  const want = Math.min(batch.want, Math.max(0, cfg.daily_target - have));
  const done = async (patch: Record<string, unknown>) => db.from("lead_engine_runs").update({ finished_at: new Date().toISOString(), ...patch }).eq("run_date", batch.run_date).eq("batch_no", batch.batch_no);
  if (want <= 0) { await done({ status: "done" }); return { batch: batch.batch_no, added: 0, note: "daily target already reached" }; }
  let found: Lead[] = [];
  try { found = await findLeads(db, cfg, plan, want + 3); }
  catch (e) { await done({ status: "failed", error: String((e as Error).message).slice(0, 500) }); return { batch: batch.batch_no, error: String(e) }; }

  const checked = await Promise.all(found.map((l) => check(l, cfg)));
  const skipped: any[] = []; let added = 0;
  for (const l of checked) {
    if (added >= want) break;
    if (l.reject) { skipped.push({ company: l.company_name, why: l.reject }); continue; }
    const r = (await db.rpc("engine_add_lead", { p: l })).data;
    if (r?.lead_code) added++; else skipped.push({ company: l.company_name, why: r?.skipped ?? "could not be saved" });
  }
  await done({ status: "done", candidates: found.length, added, skipped });
  return { batch: batch.batch_no, region: batch.region, candidates: found.length, added, skipped };
}

// ---------- 1. Find: Claude searches the web for businesses with a visible need right now ----------
async function findLeads(db: any, cfg: Cfg, plan: any, n: number): Promise<Lead[]> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set in Supabase Edge Function secrets.");
  const known = (await db.rpc("engine_known_companies", { p_limit: 300 })).data ?? "";
  const today = ist().date;
  const system = `You find sales leads for Rock Papers Scissors (RPS, rockpapersscissors.in), a Bengaluru social media and marketing agency.
Services: ${cfg.services.join(", ")}.
A "requirement lead" is a real business (not an individual) in ${plan.region} (${plan.state}) that shows, in a public source dated within the last 30 days before ${today}, a CURRENT need RPS can fill. Accept only these signals:
- hiring: a job post for social media manager / digital marketing executive / content creator / video editor / marketing manager (they need marketing capacity now);
- launch: opening a new outlet, store, restaurant, clinic, showroom, project or brand, or launching a product;
- funding: raised money recently (seed / Series A / B) and will spend on growth;
- asking: publicly looking for a marketing, social media, video or influencer agency (posts, tenders, RFPs);
- expansion: entering ${plan.region} or adding branches.
Never include: marketing/advertising/media/PR/SEO agencies or freelancers (competitors), recruitment firms posting for clients, job aggregator pages without the employer named, very large companies (5,000+ employees or listed MNCs), government departments (except public tenders), businesses that closed, or anything older than 30 days.
Focus today: ${plan.focus}.
Already in our CRM, do NOT suggest these again: ${known.slice(0, 6000)}
Use web search. Prefer the business's own website, Google listing or Instagram for the phone/email. Only give contact details you actually saw on a public business page; never guess or invent a number, email or person.`;
  const user = `Find ${n} requirement leads in ${plan.region}. Return ONLY a JSON array (no prose), each item:
{"company_name":"","website":"","city":"","state":"","industry":"","about":"one line on what they do","signal_type":"hiring|launch|funding|asking|expansion","signal_summary":"one sentence: what they need and why now","signal_date":"YYYY-MM-DD","evidence_url":"the page that shows the signal","contact_name":"","designation":"","phone":"","email":"","instagram":"","linkedin":"","services_needed":["from the RPS services list"],"score":0-100 (how likely they buy from an agency like RPS in the next 60 days)}`;
  const msgs: any[] = [{ role: "user", content: user }];
  const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 6, user_location: { type: "approximate", city: "Bengaluru", region: "Karnataka", country: "IN", timezone: "Asia/Kolkata" } }];
  const deadline = Date.now() + 115000;
  let text = "";
  for (let turn = 0; turn < 3; turn++) {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), Math.max(5000, deadline - Date.now()));
    const r = await fetch((Deno.env.get("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com") + "/v1/messages", {
      method: "POST", signal: ac.signal,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, max_tokens: 6000, system, tools, messages: msgs }),
    }).finally(() => clearTimeout(timer));
    const j = await r.json();
    if (!r.ok) throw new Error(`Claude API ${r.status}: ${j?.error?.message ?? "error"}`);
    text += (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    if (j.stop_reason !== "pause_turn" || Date.now() > deadline - 20000) break;
    msgs.push({ role: "assistant", content: j.content });   // long searches pause; let it continue
  }
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  if (a < 0 || b < a) throw new Error("Claude did not return a lead list");
  const list = JSON.parse(text.slice(a, b + 1));
  return Array.isArray(list) ? list.filter((x) => x && x.company_name) : [];
}

// ---------- 2. Check: every lead is verified in code before it reaches the portal ----------
async function get(u: string): Promise<{ ok: boolean; blocked: boolean; text: string }> {
  try {
    const url = new URL(/^https?:\/\//i.test(u) ? u : "https://" + u);
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 7000);
    const r = await fetch(url, { signal: ac.signal, redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (RPS lead check)", accept: "text/html" } }).finally(() => clearTimeout(t));
    const text = r.ok ? (await r.text()).slice(0, 400000) : "";
    return { ok: r.ok, blocked: !r.ok && (BLOCKS_BOTS.test(url.hostname) || [401, 403, 429, 999].includes(r.status)), text };
  } catch { return { ok: false, blocked: false, text: "" }; }
}
function mentions(text: string, name: string) {
  const t = text.toLowerCase(), words = name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !["the", "and", "pvt", "ltd", "private", "limited", "llp", "india", "company"].includes(w));
  return words.length > 0 && words.filter((w) => t.includes(w)).length >= Math.ceil(words.length / 2);
}
async function check(l: Lead, cfg: Cfg): Promise<Lead> {
  const c: Record<string, unknown> = {};
  const name = String(l.company_name ?? "").trim();
  const state = String(l.state ?? "") + " " + String(l.city ?? "");
  c.in_scope = cfg.allowed_states.some((s) => state.toLowerCase().includes(s.toLowerCase())) || /bengaluru|bangalore|chennai|hyderabad|kochi|cochin|vijayawada|visakhapatnam|vizag|mysuru|mangaluru|coimbatore|madurai|thiruvananthapuram|guntur|tirupati|warangal/i.test(state);
  const age = l.signal_date ? (Date.now() - Date.parse(l.signal_date)) / 864e5 : 999;
  c.signal_age_days = Math.round(age);
  c.fresh = age >= -2 && age <= 45;
  c.not_agency = !AGENCY.test(`${name} ${l.industry ?? ""} ${l.about ?? ""}`);
  c.has_contact = !!(String(l.phone ?? "").replace(/\D/g, "").length >= 10 || /@/.test(String(l.email ?? "")));
  c.score_ok = Number(l.score) >= 60;
  const [ev, web] = await Promise.all([l.evidence_url ? get(l.evidence_url) : Promise.resolve({ ok: false, blocked: false, text: "" }), l.website ? get(l.website) : Promise.resolve({ ok: false, blocked: false, text: "" })]);
  c.evidence_page = ev.ok ? (mentions(ev.text, name) ? "loads and names the business" : "loads but doesn't name the business") : ev.blocked ? "site blocks automatic checks" : "does not load";
  c.website = web.ok ? (mentions(web.text, name) ? "live" : "live, name not found") : l.website ? "not reachable" : "none";
  const evidenceOk = (ev.ok && mentions(ev.text, name)) || (ev.blocked && web.ok && mentions(web.text, name)) || (ev.blocked && mentions(String(l.evidence_url), name));
  c.evidence_ok = evidenceOk;
  const reject = !c.in_scope ? "outside the 5 states" : !c.fresh ? `signal is ${c.signal_age_days} days old or undated` : !c.not_agency ? "is an agency (competitor)"
    : !c.has_contact ? "no public phone or email" : !c.score_ok ? `low buying score (${l.score})` : !evidenceOk ? `proof not confirmed (${c.evidence_page})` : null;
  return { ...l, company_name: name, checks: c, reject };
}

// ---------- 3. Report: one email to the founder ----------
async function sendReport(db: any, cfg: Cfg, date: string) {
  const leads = await addedToday(db);
  const runs = (await db.from("lead_engine_runs").select("region,added,candidates,status,error").eq("run_date", date).order("batch_no")).data ?? [];
  const byCity: Record<string, number> = {};
  leads.forEach((l: any) => { const k = l.company?.city || "Other"; byCity[k] = (byCity[k] ?? 0) + 1; });
  const failed = runs.filter((r: any) => r.status === "failed");
  const html = `<div style="font-family:Arial,sans-serif;color:#111;max-width:760px">
<h2 style="margin:0 0 6px">${leads.length} new requirement leads are in the portal</h2>
<p style="margin:0 0 14px;color:#555">${esc(new Date(date + "T00:00:00+05:30").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }))} · target ${cfg.daily_target} · every lead below passed the automatic checks (fresh public signal, proof link, in-scope city, business phone or email, not already in the CRM).</p>
<p style="margin:0 0 14px">${Object.entries(byCity).map(([k, v]) => `<b>${esc(k)}</b> ${v}`).join(" · ") || "No leads today."}</p>
<table cellpadding="7" style="border-collapse:collapse;font-size:13px;width:100%">
<tr style="background:#111;color:#fff;text-align:left"><th>Lead</th><th>Business</th><th>Why now</th><th>Contact</th><th>With</th></tr>
${leads.map((l: any) => `<tr style="border-bottom:1px solid #ddd;vertical-align:top"><td>${esc(l.lead_code)}</td><td><b>${esc(l.company?.name)}</b><br><span style="color:#666">${esc([l.company?.industry, l.company?.city].filter(Boolean).join(" · "))}</span></td><td>${esc(String(l.status_reason ?? "").replace(/^Why now: /, ""))}</td><td>${esc(l.contact?.full_name)}${l.contact?.designation ? ", " + esc(l.contact.designation) : ""}<br>${esc(l.contact?.phone_e164 ?? "")}<br>${esc(l.contact?.email ?? "")}</td><td>${esc(l.owner?.full_name ?? "Verification desk")}</td></tr>`).join("")}
</table>
${leads.length < cfg.daily_target ? `<p style="color:#a15c00">Short of the target by ${cfg.daily_target - leads.length}. Leads that failed a check are left out on purpose rather than sending junk.${failed.length ? ` ${failed.length} search batch(es) failed: ${esc(failed.map((f: any) => f.region + " (" + (f.error ?? "error") + ")").join("; ").slice(0, 300))}` : ""}</p>` : ""}
<p><a href="${PORTAL}" style="background:#BD1911;color:#fff;padding:10px 16px;border-radius:999px;text-decoration:none">Open the portal</a></p>
<p style="color:#888;font-size:12px">RPS Lead Engine · runs every morning 07:00–09:00 IST · contact details are from public business listings and posts; respect DND and any request not to be contacted.</p></div>`;
  const key = Deno.env.get("RESEND_API_KEY");
  let err: string | null = null;
  if (!key) err = "RESEND_API_KEY is not set";
  else {
    const r = await fetch((Deno.env.get("RESEND_BASE_URL") ?? "https://api.resend.com") + "/emails", { method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from: Deno.env.get("REPORT_FROM") || "RPS Lead Engine <onboarding@resend.dev>", to: [cfg.report_email], subject: `${leads.length} new requirement leads added · ${date}`, html }) });
    if (!r.ok) err = `Resend ${r.status}: ${(await r.text()).slice(0, 300)}`;
  }
  await db.from("lead_engine_reports").upsert({ run_date: date, added: leads.length, emailed_at: err ? null : new Date().toISOString(), email_error: err });
  return { report: err ? "not sent" : "sent", added: leads.length, error: err };
}
