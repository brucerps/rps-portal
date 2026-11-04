-- RPS CRM | 014: Maya, the lead finder. The old paid robot (needs a Claude API key) is switched off;
-- Maya is the free daily Claude run that adds leads straight into the CRM. She logs each run, and the
-- portal draws her leads as a live flow from "found" to "won".
select cron.unschedule('rps-lead-engine') where exists (select 1 from cron.job where jobname = 'rps-lead-engine');
update public.lead_engine_config set active = false;
delete from public.lead_engine_runs where status = 'failed';

create table if not exists public.maya_runs (
  run_date date primary key,
  finished_at timestamptz not null default now(),
  added int not null default 0,          -- verified leads added (with a phone or email)
  pending int not null default 0,        -- strong leads sent to the Verification desk (need a phone)
  thrown_out int not null default 0,     -- candidates rejected by the checks
  reasons text,                          -- main reasons, one line
  emailed boolean not null default false
);
alter table public.maya_runs enable row level security;
drop policy if exists maya_runs_read on public.maya_runs;
create policy maya_runs_read on public.maya_runs for select to authenticated using (public.is_admin());

-- Maya calls this once at the end of her morning run
create or replace function public.maya_log_run(p jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.maya_runs(run_date, finished_at, added, pending, thrown_out, reasons, emailed)
  values ((now() at time zone 'Asia/Kolkata')::date, now(), coalesce((p->>'added')::int, 0), coalesce((p->>'pending')::int, 0),
          coalesce((p->>'thrown_out')::int, 0), left(p->>'reasons', 300), coalesce((p->>'emailed')::boolean, false))
  on conflict (run_date) do update set finished_at = excluded.finished_at, added = excluded.added, pending = excluded.pending,
    thrown_out = excluded.thrown_out, reasons = excluded.reasons, emailed = excluded.emailed;
$$;
revoke execute on function public.maya_log_run(jsonb) from public, anon, authenticated;

-- Where Maya's leads are now: one count per step of the flow, for leads she found in the period
create or replace function public.maya_flow(p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not (public.is_admin() or exists (select 1 from public.employee_roles er join public.roles ro on ro.id = er.role_id
          where er.employee_id = auth.uid() and ro.role_key = 'department_head')) then
    raise exception 'Only the founder and department heads can see this' using errcode = 'insufficient_privilege';
  end if;
  with m as (
    select l.status::text st, l.created_at, c.city
    from public.leads l join public.lead_sources s on s.id = l.source_id left join public.companies c on c.id = l.company_id
    where l.created_by is null and s.source_name in ('RPS Lead Engine (daily)', 'Outbound research list')
  ), p as (select * from m where created_at >= p_from and created_at < p_to)
  select jsonb_build_object(
    'found', (select count(*) from p),
    'desk', (select count(*) from p where st = 'verification_pending'),
    'verified', (select count(*) from p where st = 'verified'),
    'calling', (select count(*) from p where st in ('ready_to_call','no_answer','callback_scheduled')),
    'interested', (select count(*) from p where st in ('interested','discovery_scheduled','discovery_completed','hot','warm','nurture')),
    'proposal', (select count(*) from p where st in ('research','audit','strategy','proposal_draft','proposal_review','proposal_presented','revision','negotiation','pending_decision')),
    'won', (select count(*) from p where st = 'converted'),
    'dropped', (select count(*) from p where st in ('verification_rejected','closed_lost','invalid','suppressed')),
    'today', (select count(*) from m where (created_at at time zone 'Asia/Kolkata')::date = (now() at time zone 'Asia/Kolkata')::date),
    'last_added', (select max(created_at) from m),
    'cities', coalesce((select jsonb_agg(jsonb_build_array(city, n) order by n desc) from
                 (select coalesce(nullif(city, ''), 'Other') city, count(*) n from p group by 1 order by 2 desc limit 6) x), '[]'::jsonb),
    'run', (select to_jsonb(mr) from public.maya_runs mr order by run_date desc limit 1)
  ) into v_out;
  return v_out;
end $$;
revoke execute on function public.maya_flow(timestamptz, timestamptz) from public, anon;
grant execute on function public.maya_flow(timestamptz, timestamptz) to authenticated;
