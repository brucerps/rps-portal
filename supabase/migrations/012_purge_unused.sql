-- RPS CRM | 012: an employee who was removed before ever signing in frees their Employee ID and email
create or replace function public.purge_unused_employee(p_code text, p_email text)
returns int language plpgsql security definer set search_path = public, auth as $$
declare r record; n int := 0;
begin
  for r in select p.id, p.employee_code, lower(p.email) email from public.profiles p join auth.users u on u.id = p.id
           where not p.active and u.last_sign_in_at is null
             and (lower(p.employee_code) = lower(coalesce(p_code, '')) or lower(p.email) = lower(coalesce(p_email, '')))
  loop
    begin
      update public.email_outbox set attempts = 5, error = 'cancelled: employee removed before signing in'
        where sent_at is null and (lower(to_email) = r.email or kind = 'welcome' and r.email = any(cc));
      delete from public.employee_roles where employee_id = r.id;
      delete from public.portal_docs where (col = 'accounts' and id = 'u_' || r.employee_code)
        or (col in ('portal','hr') and id in ('k_ems_d_' || r.employee_code, 'k_ems_pay_' || r.employee_code));
      delete from public.profiles where id = r.id;
      delete from auth.users where id = r.id;
      n := n + 1;
    exception when foreign_key_violation then null;   -- they already have work on record: keep them
    end;
  end loop;
  return n;
end $$;
revoke execute on function public.purge_unused_employee(text, text) from public, anon, authenticated;
grant execute on function public.purge_unused_employee(text, text) to service_role;
