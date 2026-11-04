-- Applied to rps-staging on 2026-11-04 (migrations crm_custom_options_and_lost_details + crm_lists_revoke_anon).
-- Lists the founder, HR and department heads can extend from the portal ("+ Add new"): extra lead stages,
-- loss reasons and follow-up types. Closing a lead as lost needs a listed reason and written details (5+ words).
create table public.crm_options(
  kind text not null check (kind in ('stage','lost_reason','followup_type')),
  code text not null check (code ~ '^[a-z0-9_]{2,40}$'),
  label text not null check (char_length(trim(label)) between 2 and 60),
  builtin boolean not null default false,
  active boolean not null default true,
  sort int not null default 100,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (kind, code));
create unique index crm_options_label_uq on public.crm_options(kind, lower(trim(label)));
insert into public.crm_options(kind,code,label,builtin,sort,created_by) values
 ('lost_reason','price','Price',true,1,null),('lost_reason','competitor','Went with a competitor',true,2,null),
 ('lost_reason','internal_team','Doing it in-house',true,3,null),('lost_reason','postponed','Postponed',true,4,null),
 ('lost_reason','no_budget','No budget',true,5,null),('lost_reason','scope_mismatch','Scope mismatch',true,6,null),
 ('lost_reason','service_mismatch','Not a service we offer',true,7,null),('lost_reason','no_decision','No decision / no response',true,8,null),
 ('lost_reason','business_closed','Business closed',true,9,null),('lost_reason','other','Other',true,99,null),
 ('followup_type','follow_up','Follow up',true,1,null),('followup_type','callback','Call back',true,2,null),
 ('followup_type','send_details','Send details / deck',true,3,null),('followup_type','whatsapp','WhatsApp',true,4,null),
 ('followup_type','meeting_prep','Meeting prep',true,5,null);
create or replace function public.can_manage_crm_lists() returns boolean
 language sql stable security definer set search_path to 'public' as $$
  select public.is_hr() or exists (
    select 1 from public.employee_roles er join public.roles r on r.id = er.role_id
    join public.profiles p on p.id = er.employee_id and p.active
    where er.employee_id = auth.uid() and r.role_key = 'department_head');
$$;
revoke execute on function public.can_manage_crm_lists() from anon, public;
grant execute on function public.can_manage_crm_lists() to authenticated;
alter table public.crm_options enable row level security;
create policy crm_options_read on public.crm_options for select to authenticated using (public.is_active_employee());
create policy crm_options_add on public.crm_options for insert to authenticated
  with check (public.can_manage_crm_lists() and not builtin and created_by = auth.uid());
create policy crm_options_edit on public.crm_options for update to authenticated
  using (public.can_manage_crm_lists() and not builtin) with check (public.can_manage_crm_lists() and not builtin);
grant select, insert, update on public.crm_options to authenticated;
revoke all on public.crm_options from anon;
alter table public.leads add column custom_stage text;
alter table public.leads drop constraint leads_lost_reason_chk;
create or replace function public.require_lost_details() returns trigger
 language plpgsql set search_path to 'public' as $$
begin
  if new.status = 'closed_lost' and (tg_op = 'INSERT' or old.status is distinct from 'closed_lost'
       or new.lost_note is distinct from old.lost_note or new.lost_reason is distinct from old.lost_reason) then
    if new.lost_reason is null or not exists (select 1 from public.crm_options o
         where o.kind = 'lost_reason' and o.code = new.lost_reason and o.active) then
      raise exception 'Choose a loss reason from the list before closing the lead' using errcode = 'check_violation';
    end if;
    if coalesce(array_length(regexp_split_to_array(trim(coalesce(new.lost_note,'')), '\s+'), 1), 0) < 5
       or char_length(trim(coalesce(new.lost_note,''))) < 15 then
      raise exception 'Write the details of why the lead was lost (at least 5 words). The lead stays open until you do.'
        using errcode = 'check_violation';
    end if;
  end if;
  if new.custom_stage is not null and (tg_op = 'INSERT' or new.custom_stage is distinct from old.custom_stage)
     and not exists (select 1 from public.crm_options o where o.kind = 'stage' and o.code = new.custom_stage and o.active) then
    raise exception 'That stage isn''t on the stage list' using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and new.status in ('converted','closed_lost','invalid','suppressed') then new.custom_stage := null; end if;
  return new;
end $$;
create trigger leads_lost_details before insert or update on public.leads
  for each row execute function public.require_lost_details();
