// Supabase Edge Function: maya-chat
// "Ask Maya" in the portal, for the founder. Maya answers from live CRM data and can do a few simple actions
// (assign a lead, add a follow-up). Every database call runs with the founder's own login, so the normal
// database rules apply. Needs the ANTHROPIC_API_KEY secret.
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
const pick = (n: string) => { try { const o = JSON.parse(Deno.env.get(n) ?? "{}"); return (o.default ?? Object.values(o)[0]) as string | undefined; } catch { return undefined; } };
const MODEL = Deno.env.get("MAYA_MODEL") || "claude-sonnet-5-5";
const OPEN = ["verification_pending","verified","ready_to_call","no_answer","callback_scheduled","interested","discovery_scheduled","discovery_completed","hot","warm","nurture","research","audit","strategy","proposal_draft","proposal_review","proposal_presented","revision","negotiation","pending_decision"];

function istNow() { return new Date(Date.now() + 330 * 60000); }
function istDate(off = 0) { return new Date(Date.now() + 330 * 60000 + off * 864e5).toISOString().slice(0, 10); }
function periodStart(p: string) {
  const d = istNow(); d.setUTCHours(0, 0, 0, 0);
  if (p === "week") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  else if (p === "month") d.setUTCDate(1);
  else if (p === "quarter") { d.setUTCDate(1); d.setUTCMonth(Math.floor(d.getUTCMonth() / 3) * 3); }
  return new Date(d.getTime() - 330 * 60000).toISOString();
}

const TOOLS = [
  { name: "pipeline_summary", description: "Counts of leads by stage, new leads and Maya's lead-finder numbers for a period.",
    input_schema: { type: "object", properties: { period: { type: "string", enum: ["today", "week", "month", "quarter"] } }, required: ["period"] } },
  { name: "find_leads", description: "Search leads. Returns lead code, business, city, status, contact, who it is assigned to, why-now note. Use for questions about specific leads, cities, stages or a person's leads.",
    input_schema: { type: "object", properties: { text: { type: "string", description: "Part of the business name or lead code" }, status: { type: "string", description: "A lead status, or 'open' for all open leads" },
      city: { type: "string" }, employee_code: { type: "string", description: "Only leads assigned to this employee, e.g. RPS003" }, unassigned: { type: "boolean" }, limit: { type: "number" } } } },
  { name: "team_report", description: "Per-person sales numbers for a period (verified, calls, connected, interested, meetings, proposals, won, overdue tasks), plus who wrote today's plan and work report.",
    input_schema: { type: "object", properties: { period: { type: "string", enum: ["today", "week", "month", "quarter"] } }, required: ["period"] } },
  { name: "list_followups", description: "Open follow-ups: overdue, due today, or due this week, optionally for one employee.",
    input_schema: { type: "object", properties: { scope: { type: "string", enum: ["overdue", "today", "week"] }, employee_code: { type: "string" } }, required: ["scope"] } },
  { name: "list_tasks", description: "Portal tasks (non-sales work: shoots, edits, designs, posts). Open, overdue or recently done, optionally for one employee. Includes title, who gave it, who has it, due date, priority, status and the last update.",
    input_schema: { type: "object", properties: { scope: { type: "string", enum: ["open", "overdue", "done_recently", "all"] }, employee_code: { type: "string" } }, required: ["scope"] } },
  { name: "list_employees", description: "Active employees with their Employee ID, email and roles.", input_schema: { type: "object", properties: {} } },
  { name: "assign_lead", description: "Assign or reassign a lead to an employee. Only when Bruce clearly asks for it.",
    input_schema: { type: "object", properties: { lead_code: { type: "string" }, employee_code: { type: "string" }, note: { type: "string" } }, required: ["lead_code", "employee_code"] } },
  { name: "add_followup", description: "Schedule a follow-up on a lead for an employee (default: the lead's owner). Only when Bruce clearly asks for it.",
    input_schema: { type: "object", properties: { lead_code: { type: "string" }, employee_code: { type: "string" }, due_at: { type: "string", description: "ISO date-time in IST, e.g. 2026-11-05T11:00:00+05:30" },
      type: { type: "string", enum: ["follow_up", "callback", "send_details", "whatsapp", "meeting_prep"] }, note: { type: "string" } }, required: ["lead_code", "due_at"] } },
];

async function runTool(db: any, name: string, a: any): Promise<unknown> {
  const emp = async (code?: string) => code ? (await db.from("profiles").select("id,full_name,employee_code").ilike("employee_code", code).maybeSingle()).data : null;
  const lead = async (code: string) => (await db.from("leads").select("id,lead_code,assigned_to,company:companies(name)").ilike("lead_code", code).maybeSingle()).data;
  if (name === "pipeline_summary") {
    const from = periodStart(a.period || "month"), to = new Date(Date.now() + 864e5).toISOString();
    const all = (await db.from("leads").select("status,created_at").limit(10000)).data ?? [];
    const by: Record<string, number> = {}; all.forEach((l: any) => { by[l.status] = (by[l.status] || 0) + 1; });
    const maya = (await db.rpc("maya_flow", { p_from: from, p_to: to })).data;
    const overdue = (await db.from("followups").select("id", { count: "exact", head: true }).eq("status", "overdue")).count ?? 0;
    return { period: a.period, new_leads_in_period: all.filter((l: any) => l.created_at >= from).length, all_leads_by_status: by, overdue_followups: overdue, maya_lead_finder: maya };
  }
  if (name === "find_leads") {
    let q = db.from("leads").select("lead_code,status,status_reason,estimated_value,next_action_at,created_at,assigned:profiles!leads_assigned_to_fkey(full_name,employee_code),company:companies!inner(name,city,industry,website),contact:contacts(full_name,designation,phone_e164,email)")
      .order("updated_at", { ascending: false }).limit(Math.min(Number(a.limit) || 20, 50));
    if (a.text) q = /^RPS-/i.test(a.text) ? q.ilike("lead_code", `%${a.text}%`) : q.ilike("company.name", `%${a.text}%`);
    if (a.status === "open") q = q.in("status", OPEN); else if (a.status) q = q.eq("status", a.status);
    if (a.city) q = q.ilike("company.city", `%${a.city}%`);
    if (a.unassigned) q = q.is("assigned_to", null);
    if (a.employee_code) { const e = await emp(a.employee_code); if (!e) return { error: "No employee " + a.employee_code }; q = q.eq("assigned_to", e.id); }
    const r = await q; return r.error ? { error: r.error.message } : r.data;
  }
  if (name === "team_report") {
    const r = await db.rpc("report_employee_performance", { p_from: periodStart(a.period || "today"), p_to: new Date(Date.now() + 864e5).toISOString() });
    const staff = (await db.from("profiles").select("full_name,employee_code").eq("active", true)).data ?? [];
    const docs = (await db.from("portal_docs").select("id,body").eq("col", "portal").in("id", staff.map((s: any) => "k_ems_d_" + s.employee_code))).data ?? [];
    const today = istDate();
    const daily = staff.map((s: any) => { const v = docs.find((d: any) => d.id === "k_ems_d_" + s.employee_code)?.body?.v ?? {};
      return { name: s.full_name, id: s.employee_code, plan_today: v.plan?.[today]?.t ?? null, report_today: v.rep?.[today]?.t ?? null, signed_in: v.ses?.[today]?.in ?? null, signed_out: v.ses?.[today]?.out ?? null }; });
    return { numbers: r.error ? r.error.message : r.data, today: daily };
  }
  if (name === "list_followups") {
    let q = db.from("followups").select("due_at,task_type,description,status,assigned:profiles!followups_assigned_to_fkey(full_name,employee_code),lead:leads(lead_code,company:companies(name))").order("due_at").limit(60);
    if (a.scope === "overdue") q = q.eq("status", "overdue");
    else q = q.in("status", ["open", "overdue"]).lte("due_at", new Date(`${istDate(a.scope === "week" ? 6 : 0)}T23:59:59+05:30`).toISOString());
    if (a.employee_code) { const e = await emp(a.employee_code); if (!e) return { error: "No employee " + a.employee_code }; q = q.eq("assigned_to", e.id); }
    const r = await q; return r.error ? { error: r.error.message } : r.data;
  }
  if (name === "list_tasks") {
    const r = await db.from("portal_docs").select("body").eq("col", "portal").like("id", "k_ems_t_%").limit(2000);
    if (r.error) return { error: r.error.message };
    const today = istDate(), wk = istDate(-7), code = a.employee_code ? String(a.employee_code).toUpperCase() : null;
    const names: Record<string, string> = {};
    ((await db.from("profiles").select("full_name,employee_code")).data ?? []).forEach((x: any) => { names[x.employee_code] = x.full_name; });
    const open = (t: any) => ["requested", "accepted", "progress"].includes(t.st);
    const rows = (r.data ?? []).map((d: any) => d.body?.v).filter((t: any) => t && t.title && (!code || t.to === code || t.from === code))
      .filter((t: any) => a.scope === "all" ? true : a.scope === "open" ? open(t) : a.scope === "overdue" ? open(t) && t.due && t.due < today
        : t.st === "done" && String(t.up ?? t.at ?? "").slice(0, 10) >= wk)
      .sort((x: any, y: any) => String(x.due || "9999").localeCompare(String(y.due || "9999"))).slice(0, 60)
      .map((t: any) => { const l = (t.log ?? []).slice(-1)[0]; return { title: t.title, details: t.det || undefined, project: t.proj || undefined, to: names[t.to] ?? t.to, from: names[t.from] ?? t.from,
        due: t.due || null, priority: t.pri, status: t.st, last_update: l ? `${String(l.at).slice(0, 10)} ${names[l.by] ?? l.by}: ${l.a}${l.t ? " – " + l.t : ""}` : null }; });
    return rows;
  }
  if (name === "list_employees") {
    const r = await db.from("profiles").select("full_name,employee_code,email,employee_roles!employee_roles_employee_id_fkey(role:roles(display_name))").eq("active", true).order("employee_code");
    return r.error ? { error: r.error.message } : r.data;
  }
  if (name === "assign_lead") {
    const l = await lead(a.lead_code), e = await emp(a.employee_code);
    if (!l) return { error: "No lead " + a.lead_code }; if (!e) return { error: "No employee " + a.employee_code };
    const r = await db.rpc("assign_lead", { p_lead_id: l.id, p_employee_id: e.id, p_note: a.note ?? "Assigned by Maya on Bruce's request" });
    return r.error ? { error: r.error.message } : { ok: true, lead: l.lead_code, business: l.company?.name, assigned_to: e.full_name };
  }
  if (name === "add_followup") {
    const l = await lead(a.lead_code); if (!l) return { error: "No lead " + a.lead_code };
    const e = a.employee_code ? await emp(a.employee_code) : null; const who = e?.id ?? l.assigned_to;
    if (!who) return { error: "The lead has no owner. Say who should do the follow-up." };
    const r = await db.from("followups").insert({ lead_id: l.id, assigned_to: who, due_at: new Date(a.due_at).toISOString(), task_type: a.type || "follow_up", description: a.note ?? null });
    return r.error ? { error: r.error.message } : { ok: true, lead: l.lead_code, business: l.company?.name, due_at: a.due_at };
  }
  return { error: "Unknown tool" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Use POST" });
  const url = Deno.env.get("SUPABASE_URL")!, anon = Deno.env.get("SUPABASE_ANON_KEY") || pick("SUPABASE_PUBLISHABLE_KEYS")!;
  const db = createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false } });
  if ((await db.rpc("is_admin")).data !== true) return reply(403, { error: "Ask Maya is for the founder." });
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return reply(200, { error: "key_missing" });

  let body: any; try { body = await req.json(); } catch { return reply(400, { error: "Send JSON." }); }
  const history = (Array.isArray(body.messages) ? body.messages : []).slice(-16)
    .filter((m: any) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m: any) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!history.length || history[history.length - 1].role !== "user") return reply(400, { error: "Ask a question." });

  const me = (await db.rpc("portal_session")).data as any;
  const system = `You are Maya, personal assistant to Bruce, founder of Rock Papers Scissors (RPS), a Bengaluru social media and marketing agency. You live inside the RPS employee portal.
Today is ${istNow().toUTCString().slice(0, 16)} (India time, ${istDate()}). You are talking to ${me?.name ?? "Bruce"} (${me?.code ?? "founder"}).
Every morning at 6:11 AM you also find new requirement leads across Karnataka, Tamil Nadu, Telangana, Andhra Pradesh and Kerala and add them to the CRM.
Use the tools to answer from live data; never guess numbers. Keep answers short and practical: lead with the answer, then a few bullet points. Use plain words, Indian number style (₹1.2L), names rather than IDs where you can.
Only assign leads or add follow-ups when Bruce clearly asks; afterwards say exactly what you did. If he asks for something you can't do here (send emails, edit payroll, change access), say so in one line and suggest where in the portal to do it.`;

  const msgs: any[] = [...history];
  for (let i = 0; i < 6; i++) {
    const r = await fetch((Deno.env.get("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com") + "/v1/messages", { method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1200, system, tools: TOOLS, messages: msgs }) });
    if (!r.ok) { const t = await r.text(); return reply(200, { error: r.status === 401 ? "key_invalid" : "Maya couldn't answer right now (" + r.status + "). " + t.slice(0, 200) }); }
    const out = await r.json();
    msgs.push({ role: "assistant", content: out.content });
    if (out.stop_reason !== "tool_use") {
      const text = (out.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
      return reply(200, { reply: text || "Done." });
    }
    const results = [];
    for (const c of out.content) if (c.type === "tool_use") {
      let res: unknown; try { res = await runTool(db, c.name, c.input ?? {}); } catch (e) { res = { error: String((e as Error).message) }; }
      results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(res).slice(0, 30000) });
    }
    msgs.push({ role: "user", content: results });
  }
  return reply(200, { reply: "That took too many steps. Try asking in a simpler way." });
});
