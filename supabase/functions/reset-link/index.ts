// Supabase Edge Function: reset-link
// "Forgot password?" for any employee: queues a one-time reset link to their work email through our mailer.
// Always answers the same way, so it can't be used to find out who works at RPS. One link per email per 5 minutes.
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const PORTAL = "https://brucerps.github.io/rps-portal/";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
const pick = (n: string) => { try { const o = JSON.parse(Deno.env.get(n) ?? "{}"); return (o.default ?? Object.values(o)[0]) as string | undefined; } catch { return undefined; } };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const SAME = { ok: true, message: "If that email belongs to an RPS employee, a reset link is on its way." };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Use POST" });
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* fall through */ }
  const email = String(b.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, { error: "Enter your work email." });
  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || pick("SUPABASE_SECRET_KEYS")!, { auth: { persistSession: false } });
  const emp = (await svc.from("profiles").select("full_name,email").eq("active", true).ilike("email", email).maybeSingle()).data;
  if (!emp) return reply(200, SAME);
  const recent = (await svc.from("email_outbox").select("id", { count: "exact", head: true }).eq("kind", "reset").eq("to_email", email)
    .gte("created_at", new Date(Date.now() - 5 * 60000).toISOString())).count ?? 0;
  if (recent > 0) return reply(200, SAME);
  const gl = await svc.auth.admin.generateLink({ type: "recovery", email, options: { redirectTo: PORTAL } });
  const link = gl.data?.properties?.action_link;
  if (!link) return reply(200, SAME);
  await svc.from("email_outbox").insert({ kind: "reset", to_email: email, subject: "Reset your RPS portal password",
    html: `<p>Hi ${esc(String(emp.full_name ?? "").split(" ")[0])},</p><p>Someone asked to reset your Rock Papers Scissors portal password. If it was you:</p>
<p><a href="${esc(link)}" style="background:#BD1911;color:#fff;padding:10px 16px;border-radius:999px;text-decoration:none">Choose a new password</a></p>
<p style="color:#666">The link works once and expires soon. If you didn't ask for this, ignore this email; your password stays the same.</p>` });
  return reply(200, SAME);
});
