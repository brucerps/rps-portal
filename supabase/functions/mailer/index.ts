// Supabase Edge Function: mailer
// Called every minute by pg_cron. Sends what is waiting in email_outbox through Resend, and at 8:15 AM IST
// (Mon–Sat) queues each employee's morning briefing. "eod" and "briefing" emails are composed at send time
// from the employee's open tasks, follow-ups, leads and proposals. Calling it from outside only flushes the queue.
import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import nodemailer from "npm:nodemailer@6.9.16";

const PORTAL = "https://brucerps.github.io/rps-portal/";
const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
const pick = (n: string) => { try { const o = JSON.parse(Deno.env.get(n) ?? "{}"); return (o.default ?? Object.values(o)[0]) as string | undefined; } catch { return undefined; } };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const istNow = () => new Date(Date.now() + 330 * 60000);
const istDate = (offsetDays = 0) => new Date(Date.now() + 330 * 60000 + offsetDays * 864e5).toISOString().slice(0, 10);
const endOfIst = (d: string) => new Date(`${d}T23:59:59+05:30`).toISOString();
const startOfIst = (d: string) => new Date(`${d}T00:00:00+05:30`).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmtDay = (d: string) => new Date(`${d}T00:00:00+05:30`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" });
const fmtTime = (t: string) => new Date(t).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });

Deno.serve(async () => {
  const url = Deno.env.get("SUPABASE_URL")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || pick("SUPABASE_SECRET_KEYS")!;
  const db = createClient(url, service, { auth: { persistSession: false } });
  const out: Record<string, unknown> = {};

  // 1. Morning briefing, once a day at 8:15 IST (not on Sundays)
  const n = istNow(), min = n.getUTCHours() * 60 + n.getUTCMinutes(), today = istDate();
  if (n.getUTCDay() !== 0 && min >= 8 * 60 + 15 && min <= 9 * 60) {
    const { error } = await db.from("mail_runs").insert({ run_date: today, kind: "briefing" });
    if (!error) {   // first caller today wins; the primary key stops a second briefing
      const staff = (await db.from("profiles").select("id,email").eq("active", true)).data ?? [];
      const rows = staff.filter((p: any) => p.email).map((p: any) => ({ kind: "briefing", to_email: String(p.email).toLowerCase(), payload: { employee_id: p.id, for: today } }));
      if (rows.length) await db.from("email_outbox").insert(rows);
      out.briefings_queued = rows.length;
    }
  }

  // 2. Send what is waiting
  // Gmail (from the founder's own address) if its app password is set, otherwise Resend if its key is set
  const gpass = (Deno.env.get("GMAIL_APP_PASSWORD") ?? "").replace(/\s+/g, "");
  const guser = Deno.env.get("GMAIL_USER") || "info@rockpapersscissors.in";
  const key = Deno.env.get("RESEND_API_KEY");
  if (!gpass && !key) return json(200, { ...out, waiting: "No email sender connected yet (GMAIL_APP_PASSWORD); emails stay queued" });
  const from = Deno.env.get("MAIL_FROM") || (gpass ? `Rock Papers Scissors <${guser}>` : "RPS Portal <onboarding@resend.dev>");
  const smtp = gpass ? nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: guser, pass: gpass } }) : null;
  const pending = (await db.from("email_outbox").select("*").is("sent_at", null).lt("attempts", 5).order("created_at").limit(12)).data ?? [];
  let sent = 0, failed = 0;
  for (const m of pending) {
    try {
      let subject = m.subject, html = m.html;
      if (m.kind === "eod" || m.kind === "briefing") ({ subject, html } = await compose(db, m.kind, m.payload));
      if (!subject || !html) { await db.from("email_outbox").update({ attempts: 5, error: "nothing to send" }).eq("id", m.id); continue; }
      let r: { ok: boolean; status: number; text: () => Promise<string> };
      if (smtp) {
        try { await smtp.sendMail({ from, to: m.to_email, cc: m.cc?.length ? m.cc : undefined, subject, html: wrap(html) }); r = { ok: true, status: 250, text: async () => "" }; }
        catch (e) {
          const t = String((e as Error).message);
          // wrong/missing app password or a connection problem: keep every email queued and try again next minute
          if ((e as any)?.code === "EAUTH" || /ECONN|ETIMEDOUT|ESOCKET|EDNS/.test(String((e as any)?.code))) return json(200, { ...out, sent, failed, waiting: "Gmail: " + t.slice(0, 200) });
          r = { ok: false, status: 0, text: async () => "Gmail: " + t };
        }
      } else {
        const x = await fetch((Deno.env.get("RESEND_BASE_URL") ?? "https://api.resend.com") + "/emails", {
          method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ from, to: [m.to_email], cc: m.cc?.length ? m.cc : undefined, subject, html: wrap(html) }) });
        r = { ok: x.ok, status: x.status, text: () => x.text() };
      }
      if (r.ok) { await db.from("email_outbox").update({ sent_at: new Date().toISOString(), subject, error: null, attempts: m.attempts + 1 }).eq("id", m.id); sent++; }
      else { await db.from("email_outbox").update({ attempts: m.attempts + 1, error: `${r.status ? "Resend " + r.status + ": " : ""}${(await r.text()).slice(0, 300)}` }).eq("id", m.id); failed++; }
    } catch (e) {
      await db.from("email_outbox").update({ attempts: m.attempts + 1, error: String((e as Error).message).slice(0, 300) }).eq("id", m.id); failed++;
    }
    await sleep(2500);   // space the emails out so they don't look like a blast
  }
  return json(200, { ...out, sent, failed, pending: pending.length });
});

function wrap(body: string) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:720px;font-size:14px;line-height:1.5">${body}
<p style="margin-top:22px"><a href="${PORTAL}" style="background:#BD1911;color:#fff;padding:10px 16px;border-radius:999px;text-decoration:none">Open the RPS portal</a></p>
<p style="color:#888;font-size:12px">Rock Papers Scissors · employee portal</p></div>`;
}
function table(head: string[], rows: string[][]) {
  if (!rows.length) return "";
  return `<table cellpadding="6" style="border-collapse:collapse;width:100%;font-size:13px;margin:6px 0 14px"><tr style="background:#111;color:#fff;text-align:left">${head.map((h) => `<th>${h}</th>`).join("")}</tr>${rows.map((r) => `<tr style="border-bottom:1px solid #ddd;vertical-align:top">${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`;
}

// Tasks, follow-ups, leads and proposals for one person, as of a given day
async function compose(db: any, kind: string, p: any) {
  const emp = (await db.from("profiles").select("id,full_name,employee_code,email").eq("id", p.employee_id).single()).data;
  if (!emp) return { subject: null, html: null };
  const day: string = p.for, end = endOfIst(day), first = String(emp.full_name ?? "").split(" ")[0];
  const roles = ((await db.from("employee_roles").select("role:roles(role_key)").eq("employee_id", emp.id)).data ?? []).map((r: any) => r.role?.role_key);
  const isFounder = roles.includes("admin");

  // portal tasks assigned to them that are still open
  const tdocs = (await db.from("portal_docs").select("body").eq("col", "portal").like("id", "k_ems_t_%").eq("body->v->>to", emp.employee_code)).data ?? [];
  const tasks = tdocs.map((d: any) => d.body?.v).filter((t: any) => t && ["requested", "accepted", "progress"].includes(t.st))
    .sort((a: any, b: any) => String(a.due || "9999").localeCompare(String(b.due || "9999")));
  const dueTasks = tasks.filter((t: any) => !t.due || t.due <= day);
  const fups = (await db.from("followups").select("due_at,task_type,description,status,lead:leads(lead_code,company:companies(name))")
    .eq("assigned_to", emp.id).in("status", ["open", "overdue"]).lte("due_at", end).order("due_at").limit(40)).data ?? [];
  const calls = (await db.from("leads").select("lead_code,status,updated_at,company:companies(name,city),contact:contacts(phone_e164)")
    .eq("assigned_to", emp.id).in("status", ["ready_to_call", "no_answer", "callback_scheduled"]).order("updated_at", { ascending: false }).limit(60)).data ?? [];
  const since = new Date(new Date(startOfIst(day)).getTime() - 15 * 3600e3).toISOString();   // from 9 PM the day before
  const fresh = calls.filter((l: any) => l.status === "ready_to_call" && l.updated_at >= since);
  const props = (await db.from("leads").select("lead_code,status,company:companies(name)")
    .eq("assigned_to", emp.id).in("status", ["hot", "research", "audit", "strategy", "proposal_draft", "revision"]).limit(30)).data ?? [];

  const label: Record<string, string> = { hot: "Hot: start research", research: "Research", audit: "Audit", strategy: "Strategy", proposal_draft: "Write proposal", revision: "Revise proposal" };
  let html = kind === "briefing"
    ? `<h2 style="margin:0 0 4px">Good morning, ${esc(first)}.</h2><p style="color:#555;margin:0 0 14px">${esc(fmtDay(day))} · your work for today. Start your day in the portal with today's plan.</p>`
    : `<h2 style="margin:0 0 4px">Tomorrow's tasks, ${esc(first)}.</h2><p style="color:#555;margin:0 0 14px">For ${esc(fmtDay(day))}. Thanks for filing today's report.</p>`;
  const counts = [`<b>${dueTasks.length}</b> task${dueTasks.length === 1 ? "" : "s"}`, `<b>${fups.length}</b> follow-up${fups.length === 1 ? "" : "s"}`, `<b>${calls.length}</b> lead${calls.length === 1 ? "" : "s"} to call`, `<b>${props.length}</b> proposal${props.length === 1 ? "" : "s"} to work on`];
  html += `<p style="font-size:15px">${counts.join(" · ")}</p>`;
  if (kind === "briefing" && fresh.length) html += `<h3 style="margin:14px 0 4px">New leads for you today (${fresh.length})</h3>` + table(["Lead", "Business", "City", "Phone"], fresh.slice(0, 15).map((l: any) => [esc(l.lead_code), esc(l.company?.name), esc(l.company?.city), esc(l.contact?.phone_e164 ?? "")]));
  if (dueTasks.length) html += `<h3 style="margin:14px 0 4px">Tasks</h3>` + table(["Task", "Due", "Status"], dueTasks.slice(0, 20).map((t: any) => [esc(t.title), esc(t.due || "No date"), esc(t.st === "requested" ? "Waiting for you to accept" : t.st === "progress" ? "In progress" : "Accepted")]));
  if (fups.length) html += `<h3 style="margin:14px 0 4px">Follow-ups</h3>` + table(["When", "Business", "What"], fups.slice(0, 20).map((f: any) => [esc(fmtTime(f.due_at)) + (new Date(f.due_at) < new Date() ? ' <b style="color:#c00">overdue</b>' : ""), esc(f.lead?.company?.name), esc(f.description || String(f.task_type).replace(/_/g, " "))]));
  if (props.length) html += `<h3 style="margin:14px 0 4px">Proposals to work on</h3>` + table(["Lead", "Business", "Next step"], props.map((l: any) => [esc(l.lead_code), esc(l.company?.name), esc(label[l.status] ?? l.status)]));
  if (calls.length && kind !== "briefing") html += `<p>Calling queue: <b>${calls.length}</b> lead${calls.length === 1 ? "" : "s"} waiting.</p>`;

  if (isFounder) {   // the founder also sees the team picture
    let yd = new Date(new Date(`${day}T12:00:00Z`).getTime() - 864e5);
    if (yd.getUTCDay() === 0) yd = new Date(yd.getTime() - 864e5);   // Monday looks back to Saturday
    const yday = yd.toISOString().slice(0, 10);   // the working day before
    const staff = (await db.from("profiles").select("full_name,employee_code").eq("active", true)).data ?? [];
    const ids = staff.map((s: any) => "k_ems_d_" + s.employee_code);
    const docs = (await db.from("portal_docs").select("id,body").eq("col", "portal").in("id", ids)).data ?? [];
    const filed = new Set(docs.filter((d: any) => d.body?.v?.rep?.[yday]).map((d: any) => d.id));
    const missing = staff.filter((s: any) => s.employee_code && !filed.has("k_ems_d_" + s.employee_code) && s.employee_code !== emp.employee_code);
    const verified = (await db.from("leads").select("id", { count: "exact", head: true }).eq("status", "verified").is("assigned_to", null)).count ?? 0;
    html += `<h3 style="margin:14px 0 4px">Team</h3><p>${missing.length ? `No work report for ${esc(fmtDay(yday))} from: <b>${missing.map((m: any) => esc(m.full_name)).join(", ")}</b>` : `Everyone filed a work report for ${esc(fmtDay(yday))}.`}<br>Verified leads waiting for a caller: <b>${verified}</b></p>`;
  }
  if (!dueTasks.length && !fups.length && !calls.length && !props.length && !isFounder) html += `<p>Nothing is scheduled for you yet. Check with your manager and add today's plan in the portal.</p>`;
  const subject = kind === "briefing" ? `Today's work · ${fmtDay(day)}` : `Tomorrow's tasks · ${fmtDay(day)}`;
  return { subject, html };
}
