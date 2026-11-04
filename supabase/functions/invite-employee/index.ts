// Supabase Edge Function: invite-employee
// HR (or the founder) creates an employee: Supabase sends the invite email, and the profile, roles
// and portal record are created. The service key stays on Supabase's servers.
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const PORTAL = "https://brucerps.github.io/rps-portal/";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Use POST" });
  const url = Deno.env.get("SUPABASE_URL")!;
  const pick = (name: string) => { try { const o = JSON.parse(Deno.env.get(name) ?? "{}"); return (o.default ?? Object.values(o)[0]) as string | undefined; } catch { return undefined; } };
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || pick("SUPABASE_PUBLISHABLE_KEYS")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || pick("SUPABASE_SECRET_KEYS")!;
  const auth = req.headers.get("Authorization") ?? "";

  // 1. Who is asking? Checked with their own login, so the database rules decide.
  const asCaller = createClient(url, anon, { global: { headers: { Authorization: auth } } });
  const hr = await asCaller.rpc("is_hr");
  if (hr.error || hr.data !== true) return reply(403, { error: "Only HR or the founder can create employees." });
  const admin = (await asCaller.rpc("is_admin")).data === true;

  // 2. Check the details
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return reply(400, { error: "Send the employee details as JSON." }); }
  const email = String(b.email ?? "").trim().toLowerCase();
  const name = String(b.name ?? "").trim();
  const code = String(b.code ?? "").trim().toUpperCase();
  const dept = String(b.dept ?? "").trim();
  const roles = Array.isArray(b.roles) ? (b.roles as unknown[]).map(String) : [];
  const portal = (b.portal && typeof b.portal === "object") ? b.portal as Record<string, unknown> : {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, { error: "Enter a valid work email." });
  if (name.length < 2) return reply(400, { error: "Enter the employee's full name." });
  if (!/^RPS\d{3,4}$/.test(code)) return reply(400, { error: "Employee ID must look like RPS012." });
  if (!admin && roles.some((r) => r === "admin" || r === "hr")) return reply(403, { error: "Only the founder can give admin or HR access." });

  const svc = createClient(url, service, { auth: { persistSession: false } });
  const taken = await svc.from("profiles").select("id").ilike("employee_code", code).maybeSingle();
  if (taken.data) return reply(409, { error: `Employee ID ${code} is already in use.` });

  // 3. Invite (Supabase emails them a link to set their password)
  const inv = await svc.auth.admin.inviteUserByEmail(email, { redirectTo: PORTAL, data: { full_name: name, employee_code: code } });
  if (inv.error || !inv.data.user) {
    const m = inv.error?.message ?? "";
    return reply(/already.*registered|exists/i.test(m) ? 409 : 502, { error: /already/i.test(m) ? "Someone with that email already has an account." : "The invite email could not be sent: " + m });
  }
  const uid = inv.data.user.id;

  // 4. Profile, roles and portal record
  let deptId: string | null = null;
  if (dept) {
    const d = await svc.from("departments").select("id").ilike("name", dept).maybeSingle();
    deptId = d.data?.id ?? null;
  }
  const p = await svc.from("profiles").insert({ id: uid, employee_code: code, full_name: name, email, department_id: deptId });
  if (p.error) { await svc.auth.admin.deleteUser(uid); return reply(500, { error: "Profile not saved: " + p.error.message }); }
  if (roles.length) {
    const r = await svc.from("roles").select("id, role_key").in("role_key", roles);
    const me = (await asCaller.auth.getUser(auth.replace(/^Bearer /i, ""))).data.user?.id ?? null;
    await svc.from("employee_roles").insert((r.data ?? []).map((x) => ({ employee_id: uid, role_id: x.id, assigned_by: me })));
  }
  const v = { ...portal, name, email, dept: dept || portal.dept, company: "Rock Papers Scissors" } as Record<string, unknown>;
  delete v.pw;
  await svc.from("portal_docs").upsert({ col: "accounts", id: "u_" + code, body: { k: "user", id: code, v } });
  return reply(201, { ok: true, code, email, invited: true });
});
