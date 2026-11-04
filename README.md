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
- **Invites:** `supabase/functions/invite-employee` runs on Supabase. It checks the caller is HR or the founder, then sends the invite.

The publishable key in `index.html` is public by design. Without a signed-in employee it can read nothing.
