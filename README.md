# RPS Employee Portal

The Rock Papers Scissors employee portal: attendance, leaves, tasks, payslips and ID cards, plus the sales CRM
(verification desk, calling queue, leads, follow-ups and the founder's sales pipeline). Everyone uses one link and one login.

**Live:** https://brucerps.github.io/rps-portal/

## How it works

- **Sign-in:** Supabase Auth. Employees sign in with their Employee ID (e.g. RPS012) or work email. HR creates accounts from
  the HR desk. The employee gets an invite email and chooses their own password, and HR never sees it.
- **Data:** the `rps-staging` Supabase project (Mumbai). Portal records live in `portal_docs`, and sales data lives in the CRM tables.
  - Database access rules decide what each person receives. An employee sees only their own attendance and payslip, while HR
    and the founder see everyone.
  - Every sales SOP rule (verification before calling, stage gates, loss reasons, do-not-contact) is enforced by the database.
- **Live updates:** Supabase Realtime, so changes on one device appear on the others.
- **Sales screens by role:**
  - lead generation: Leads
  - verifier: Verification desk
  - telecaller and sales: Calling queue and Follow-ups
  - founder and department heads: Sales pipeline
  - HR: Sales access
- **Lead robot (`supabase/functions/lead-engine`):** every morning from 07:00 to 09:00 IST it does the following.
  - It finds requirement leads across KA, TN, TS, AP and KL (half from Bengaluru) with Claude web search. These are businesses that are hiring marketing people, launching, freshly funded or asking for an agency.
  - It checks each lead in code: the proof page loads and names the business, the signal is under 45 days old, the business is in scope, there's a business phone or email, it isn't an agency, and it isn't already in the CRM.
  - It adds the leads that pass as verified and hands them to telecallers.
  - It emails the founder by 9:15.
  - Settings live in `lead_engine_config`. It needs the `ANTHROPIC_API_KEY` and `RESEND_API_KEY` secrets.
- **Invites:** `supabase/functions/invite-employee` runs on Supabase. It checks the caller is HR or the founder, then sends the invite.

The publishable key in `index.html` is public by design. Without a signed-in employee it can read nothing.
