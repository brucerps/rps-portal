// Supabase Edge Function: invite-employee
// HR (or the founder) creates an employee. Checks the caller is HR/founder against the database, creates the login
// with a one-time "set your password" link, saves profile, roles and portal record, and queues one welcome email to
// the new employee with the founder in CC, plus a note to the founder. The service key never leaves Supabase.
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const PORTAL = "https://brucerps.github.io/rps-portal/";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
const pick = (n: string) => { try { const o = JSON.parse(Deno.env.get(n) ?? "{}"); return (o.default ?? Object.values(o)[0]) as string | undefined; } catch { return undefined; } };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Use POST" });
  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || pick("SUPABASE_PUBLISHABLE_KEYS")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || pick("SUPABASE_SECRET_KEYS")!;
  const auth = req.headers.get("Authorization") ?? "";

  // 1. Who is asking? Checked with their own login, so the database rules decide.
  const asCaller = createClient(url, anon, { global: { headers: { Authorization: auth } } });
  const hr = await asCaller.rpc("is_hr");
  if (hr.error || hr.data !== true) return reply(403, { error: "Only HR or the founder can create employees." });
  const admin = (await asCaller.rpc("is_admin")).data === true;
  const caller = (await asCaller.rpc("portal_session")).data as { id?: string; name?: string; code?: string } | null;

  // 2. Check the details
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return reply(400, { error: "Send the employee details as JSON." }); }
  const email = String(b.email ?? "").trim().toLowerCase();
  const name = String(b.name ?? "").trim();
  const code = String(b.code ?? "").trim().toUpperCase();
  const dept = String(b.dept ?? "").trim();
  const roles = Array.isArray(b.roles) ? [...new Set((b.roles as unknown[]).map(String))] : [];
  const portal = (b.portal && typeof b.portal === "object") ? b.portal as Record<string, unknown> : {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, { error: "Enter a valid work email." });
  if (name.length < 2) return reply(400, { error: "Enter the employee's full name." });
  if (!/^RPS\d{3,4}$/.test(code)) return reply(400, { error: "Employee ID must look like RPS012." });
  if (!admin && roles.some((r) => r === "admin" || r === "hr")) return reply(403, { error: "Only the founder can give admin or HR access." });

  const svc = createClient(url, service, { auth: { persistSession: false } });
  const taken = await svc.from("profiles").select("id").ilike("employee_code", code).maybeSingle();
  if (taken.data) return reply(409, { error: `Employee ID ${code} is already in use.` });

  // 3. Create the login with a one-time "set your password" link (sent by our own mailer, not Supabase's)
  const gl = await svc.auth.admin.generateLink({ type: "invite", email, options: { redirectTo: PORTAL, data: { full_name: name, employee_code: code } } });
  if (gl.error || !gl.data?.user) {
    const m = gl.error?.message ?? "";
    return reply(/already|exists|registered/i.test(m) ? 409 : 502, { error: /already|exists|registered/i.test(m) ? "Someone with that email already has an account." : "The login could not be created: " + m });
  }
  const uid = gl.data.user.id, link = gl.data.properties?.action_link;

  // 4. Profile, roles, portal record
  let deptId: string | null = null;
  if (dept) deptId = (await svc.from("departments").select("id").ilike("name", dept).maybeSingle()).data?.id ?? null;
  const p = await svc.from("profiles").insert({ id: uid, employee_code: code, full_name: name, email, department_id: deptId });
  if (p.error) { await svc.auth.admin.deleteUser(uid); return reply(500, { error: "Profile not saved: " + p.error.message }); }
  const roleRows = (await svc.from("roles").select("id, role_key, display_name").in("role_key", roles.length ? roles : ["__none__"])).data ?? [];
  if (roleRows.length) await svc.from("employee_roles").insert(roleRows.map((x: any) => ({ employee_id: uid, role_id: x.id, assigned_by: caller?.id ?? null })));
  const v = { ...portal, name, email, dept: dept || portal.dept, company: "Rock Papers Scissors" } as Record<string, unknown>;
  delete v.pw;
  await svc.from("portal_docs").upsert({ col: "accounts", id: "u_" + code, body: { k: "user", id: code, v } });

  // 5. Emails: welcome (founder in CC) + note to the founder
  const founders: string[] = (await svc.rpc("founder_emails")).data ?? [];
  const roleNames = roleRows.map((r: any) => r.display_name).sort().join(", ") || "Employee (dashboard, tasks, payslip)";
  const by = caller?.name ? `${caller.name} (${caller.code})` : "HR";
  await svc.from("email_outbox").insert([
    { kind: "welcome", to_email: email, cc: founders.filter((f) => f !== email), subject: "Welcome to Rock Papers Scissors: set up your portal login",
      html: `<p>Hi ${esc(name.split(" ")[0])},</p><p>Welcome to Rock Papers Scissors. Your employee portal account is ready.</p>
<ul><li>Employee ID: <b>${esc(code)}</b></li><li>Work email: <b>${esc(email)}</b></li><li>Access: <b>${esc(roleNames)}</b></li></ul>
<p><a href="${esc(link)}" style="background:#BD1911;color:#fff;padding:10px 16px;border-radius:999px;text-decoration:none">Set your password</a></p>
<p style="color:#666">This link works once and expires soon. If it has expired, open the portal and use “Forgot password?”.</p>
<p>Every day: write your plan when you sign in, and your work report before you sign out.</p><p>Rock Papers Scissors HR</p>` },
    ...(founders.length ? [{ kind: "access", to_email: founders[0], cc: founders.slice(1), subject: `New employee onboarded: ${name} (${code})`,
      html: `<p><b>${esc(name)}</b> (${esc(code)}, ${esc(email)}) was added to the portal by ${esc(by)}.</p><ul><li>Given: <b>${esc(roleNames)}</b></li></ul>` }] : []),
  ]);
  return reply(201, { ok: true, code, email, invited: true });
});
