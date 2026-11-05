-- RPS CRM: "Why now" gets its own home on the lead, with dates, so notes and stage reasons
-- can never overwrite it again (they used to share leads.status_reason).
alter table public.leads
  add column if not exists why_now text,
  add column if not exists why_now_signal_date date,          -- when it happened (funding, launch, hiring post...)
  add column if not exists why_now_found_at timestamptz;      -- when it reached us

-- Backfill: the why-now text from status_reason, or (if a note overwrote it) from the engine's source_reference
update public.leads l set
  why_now = coalesce(
    case when l.status_reason ilike 'why now:%' then nullif(trim(substr(l.status_reason, 9)), '') end,
    nullif(trim(regexp_replace(coalesce(l.source_reference, ''), '^[a-z_]+:\s*', '')), '')),
  why_now_found_at = l.created_at,
  why_now_signal_date = (select nullif(v.evidence->>'signal_date', '')::date from public.lead_verifications v
                          where v.lead_id = l.id and v.evidence ? 'signal_date' order by v.created_at limit 1)
where l.why_now is null;

-- Every new lead (Maya's run, the engine, imports) gets why_now filled from "Why now: ..." automatically
create or replace function public.lead_capture_why_now() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.why_now is null and new.status_reason ilike 'why now:%' then
    new.why_now := nullif(trim(substr(new.status_reason, 9)), '');
  end if;
  if new.why_now is not null and new.why_now_found_at is null then
    new.why_now_found_at := coalesce(new.created_at, now());
  end if;
  return new;
end $$;
drop trigger if exists trg_lead_capture_why_now on public.leads;
create trigger trg_lead_capture_why_now before insert on public.leads
  for each row execute function public.lead_capture_why_now();

-- The engine also passes the date of the signal itself
create or replace function public.lead_signal_date_from_verification() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.evidence ? 'signal_date' and coalesce(new.evidence->>'signal_date', '') ~ '^\d{4}-\d{2}-\d{2}' then
    update public.leads set why_now_signal_date = (new.evidence->>'signal_date')::date
    where id = new.lead_id and why_now_signal_date is null;
  end if;
  return new;
end $$;
drop trigger if exists trg_lead_signal_date on public.lead_verifications;
create trigger trg_lead_signal_date after insert on public.lead_verifications
  for each row execute function public.lead_signal_date_from_verification();
