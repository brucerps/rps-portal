-- RPS CRM | 011: role-based access for every department + automatic emails
-- Emails go into email_outbox and the "mailer" Edge Function sends them (every minute) through Resend.

begin;

-- Department roles (no sales permissions; they decide which portal screens a person sees)
insert into public.roles(role_key, display_name) values
  ('designer','Designer'), ('video_editor','Video editor'), ('content_writer','Content writer'),
  ('social_media_manager','Social media manager'), ('account_manager','Account manager')
on conflict (role_key) do nothing;

create table public.email_outbox (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('welcome','access','eod','briefing','reset','notice')),
  to_email text not null,
  cc text[] not null default '{}',
  subject text,
  html text,
  payload jsonb not null default '{}'::jsonb,   -- for eod/briefing: who and which day; composed at send time
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  attempts int not null default 0,
  sent_at timestamptz,
  error text
);
create index email_outbox_pending_idx on public.email_outbox(created_at) where sent_at is null;
alter table public.email_outbox enable row level security;
create policy email_outbox_admin_read on public.email_outbox for select to authenticated using (public.is_admin());
create policy email_outbox_active on public.email_outbox as restrictive for all to authenticated
  using (public.is_active_employee()) with check (public.is_active_employee());

create table public.mail_runs (run_date date not null, kind text not null, done_at timestamptz not null default now(), primary key (run_date, kind));
alter table public.mail_runs enable row level security;

create or replace function public.founder_emails()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct lower(p.email)), '{}') from public.profiles p
  join public.employee_roles er on er.employee_id = p.id join public.roles r on r.id = er.role_id
  where r.role_key = 'admin' and p.active;
$$;

create or replace function public.role_names(p_keys text[])
returns text language sql stable set search_path = public as $$
  select coalesce(string_agg(display_name, ', ' order by display_name), 'none') from public.roles where role_key = any(p_keys);
$$;

create or replace function public.esc_html(p text)
returns text language sql immutable as $$
  select replace(replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;');
$$;

-- Queue the two access emails: the employee (founder in CC) when something is given, and the founder always
create or replace function public.queue_access_mail(p_employee uuid, p_added text[], p_removed text[], p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare e public.profiles%rowtype; v_by text; v_f text[] := public.founder_emails(); v_now text := to_char(now() at time zone 'Asia/Kolkata', 'DD Mon YYYY, HH12:MI AM');
begin
  select * into e from public.profiles where id = p_employee;
  select coalesce(full_name || ' (' || employee_code || ')', 'System') into v_by from public.profiles where id = auth.uid();
  v_by := coalesce(v_by, 'System');
  if coalesce(array_length(p_added, 1), 0) > 0 and e.email is not null then
    insert into public.email_outbox(kind, to_email, cc, subject, html) values ('access', lower(e.email),
      array(select x from unnest(v_f) x where x <> lower(e.email)),
      'Your RPS portal access: ' || public.role_names(p_added),
      '<p>Hi ' || public.esc_html(split_part(e.full_name, ' ', 1)) || ',</p><p>You now have <b>' || public.esc_html(public.role_names(p_added)) ||
      '</b> access on the Rock Papers Scissors employee portal.</p><p>Sign in with your Employee ID <b>' || public.esc_html(e.employee_code) ||
      '</b> or your work email: <a href="https://brucerps.github.io/rps-portal/">brucerps.github.io/rps-portal</a></p><p style="color:#666">Given by ' ||
      public.esc_html(v_by) || ' on ' || v_now || '.</p><p>Rock Papers Scissors HR</p>');
  end if;
  if (coalesce(array_length(p_added, 1), 0) + coalesce(array_length(p_removed, 1), 0) > 0 or p_note is not null) and array_length(v_f, 1) > 0 then
    insert into public.email_outbox(kind, to_email, cc, subject, html) values ('access', v_f[1], v_f[2:],
      'Access changed: ' || coalesce(e.full_name, 'employee') || ' (' || coalesce(e.employee_code, '') || ')',
      '<p><b>' || public.esc_html(e.full_name) || '</b> (' || public.esc_html(e.employee_code) || ', ' || public.esc_html(e.email) || ')</p><ul>' ||
      case when coalesce(array_length(p_added, 1), 0) > 0 then '<li>Given: <b>' || public.esc_html(public.role_names(p_added)) || '</b></li>' else '' end ||
      case when coalesce(array_length(p_removed, 1), 0) > 0 then '<li>Removed: <b>' || public.esc_html(public.role_names(p_removed)) || '</b></li>' else '' end ||
      case when p_note is not null then '<li>' || public.esc_html(p_note) || '</li>' else '' end ||
      '</ul><p style="color:#666">Changed by ' || public.esc_html(v_by) || ' on ' || v_now || '.</p>');
  end if;
end $$;

-- the admin/HR part of a role list, for comparing before and after
create or replace function public.top_roles(p text[]) returns text language sql immutable as $$
  select coalesce(string_agg(x, ',' order by x), '') from unnest(p) x where x in ('admin','hr');
$$;

-- HR / founder set roles: same rules as before, now with the emails
create or replace function public.portal_set_roles(p_code text, p_roles text[])
returns void language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_old text[]; v_new text[];
begin
  if not public.is_hr() then raise exception 'Only HR can change roles' using errcode = 'insufficient_privilege'; end if;
  select id into v_id from public.profiles where lower(employee_code) = lower(p_code);
  if v_id is null then raise exception 'No employee with ID %', p_code using errcode = 'no_data_found'; end if;
  select coalesce(array_agg(r.role_key), '{}') into v_old from public.employee_roles er join public.roles r on r.id = er.role_id where er.employee_id = v_id;
  select coalesce(array_agg(distinct x), '{}') into v_new from unnest(p_roles) x where exists (select 1 from public.roles r where r.role_key = x);
  if not public.is_admin() and public.top_roles(v_new) is distinct from public.top_roles(v_old) then
    raise exception 'Only the founder can give or take away admin or HR access' using errcode = 'insufficient_privilege';
  end if;
  if v_id = auth.uid() and 'admin' = any(v_old) and not ('admin' = any(v_new)) then
    raise exception 'You cannot remove your own admin access' using errcode = 'check_violation';
  end if;
  delete from public.employee_roles er where er.employee_id = v_id
    and er.role_id not in (select id from public.roles where role_key = any(v_new));
  insert into public.employee_roles(employee_id, role_id, assigned_by)
  select v_id, r.id, auth.uid() from public.roles r where r.role_key = any(v_new)
  on conflict do nothing;
  perform public.queue_access_mail(v_id,
    array(select x from unnest(v_new) x except select y from unnest(v_old) y),
    array(select y from unnest(v_old) y except select x from unnest(v_new) x));
end $$;


create or replace function public.portal_set_active(p_code text, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_hr() then raise exception 'Only HR can change who has access' using errcode = 'insufficient_privilege'; end if;
  if lower(p_code) = lower(public.my_code()) then raise exception 'You cannot switch off your own account' using errcode = 'check_violation'; end if;
  if not p_active and exists (select 1 from public.profiles p join public.employee_roles er on er.employee_id = p.id
                              join public.roles r on r.id = er.role_id where lower(p.employee_code) = lower(p_code) and r.role_key = 'admin')
     and not public.is_admin() then
    raise exception 'Only the founder can remove an admin' using errcode = 'insufficient_privilege';
  end if;
  update public.profiles set active = p_active where lower(employee_code) = lower(p_code) returning id into v_id;
  if v_id is null then raise exception 'No employee with ID %', p_code using errcode = 'no_data_found'; end if;
  perform public.queue_access_mail(v_id, '{}', '{}', case when p_active then 'Portal login switched back ON' else 'Portal login switched OFF (removed from the portal)' end);
end $$;

-- Logout: queue "tomorrow's tasks" for the signed-in employee (composed by the mailer when it sends)
create or replace function public.queue_eod_mail()
returns void language plpgsql security definer set search_path = public as $$
declare e public.profiles%rowtype;
begin
  select * into e from public.profiles where id = auth.uid() and active;
  if not found or e.email is null then return; end if;
  if exists (select 1 from public.email_outbox where kind = 'eod' and created_by = e.id and created_at > now() - interval '20 minutes') then return; end if;
  insert into public.email_outbox(kind, to_email, subject, payload)
  values ('eod', lower(e.email), null, jsonb_build_object('employee_id', e.id, 'for', ((now() at time zone 'Asia/Kolkata')::date
           + case when extract(dow from (now() at time zone 'Asia/Kolkata')::date + 1) = 0 then 2 else 1 end)::text));   -- Saturday → Monday
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.queue_access_mail(uuid, text[], text[], text)','public.founder_emails()']
  loop execute format('revoke execute on function %s from public, anon, authenticated', f); end loop;
  foreach f in array array['public.queue_eod_mail()','public.portal_set_roles(text, text[])','public.portal_set_active(text, boolean)']
  loop execute format('revoke execute on function %s from public, anon', f); execute format('grant execute on function %s to authenticated', f); end loop;
end $$;
grant select, insert, update on public.email_outbox, public.mail_runs to service_role;
grant execute on function public.founder_emails(), public.queue_access_mail(uuid, text[], text[], text) to service_role;

-- Send queued emails every minute, and the 8:15 AM briefing (the mailer decides what is due)
select cron.schedule('rps-mailer', '* * * * *',
  $c$select net.http_post(url := 'https://rcnvbrpoheefipuaxlmx.supabase.co/functions/v1/mailer',
                          headers := '{"Content-Type":"application/json"}'::jsonb, body := '{"source":"cron"}'::jsonb,
                          timeout_milliseconds := 5000)$c$);

commit;
