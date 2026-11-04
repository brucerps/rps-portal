-- RPS CRM | 013: when HR or the founder edits an employee's email in the portal, the login and the mail address follow.
-- If the person has never signed in, a fresh welcome email (founder in CC) goes to the new address.
create or replace function public.sync_employee_email() returns trigger
language plpgsql security definer set search_path = public, auth as $$
declare v_new text := lower(trim(new.body->'v'->>'email')); v_id uuid; v_old text; v_signed timestamptz;
begin
  if new.col <> 'accounts' or v_new is null or v_new !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then return new; end if;
  select p.id, lower(p.email), u.last_sign_in_at into v_id, v_old, v_signed
    from public.profiles p join auth.users u on u.id = p.id where 'u_' || p.employee_code = new.id;
  if v_id is null or v_old = v_new then return new; end if;
  if not public.is_hr() then return new; end if;   -- only HR or the founder can move someone's login
  if exists (select 1 from auth.users where lower(email) = v_new and id <> v_id) then
    raise exception 'Another account already uses %', v_new using errcode = 'unique_violation';
  end if;
  update auth.users set email = v_new, updated_at = now() where id = v_id;
  update auth.identities set identity_data = identity_data || jsonb_build_object('email', v_new), updated_at = now()
    where user_id = v_id and provider = 'email';
  update public.profiles set email = v_new where id = v_id;
  update public.email_outbox set attempts = 5, error = 'cancelled: email address changed'
    where sent_at is null and lower(to_email) = v_old;
  perform public.queue_access_mail(v_id, '{}', '{}', 'Work email changed from ' || v_old || ' to ' || v_new);
  if v_signed is null then   -- never signed in: send the welcome email again to the right address
    perform net.http_post(url := 'https://rcnvbrpoheefipuaxlmx.supabase.co/functions/v1/reset-link',
      headers := '{"Content-Type":"application/json"}'::jsonb, body := jsonb_build_object('email', v_new), timeout_milliseconds := 15000);
  end if;
  return new;
end $$;
revoke execute on function public.sync_employee_email() from public, anon, authenticated;
drop trigger if exists portal_docs_email_sync on public.portal_docs;
create trigger portal_docs_email_sync after insert or update on public.portal_docs
  for each row when (new.col = 'accounts') execute function public.sync_employee_email();
