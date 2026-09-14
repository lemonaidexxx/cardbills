begin;
create or replace function public.bb_read_version() returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare w public.bb_workspaces;
begin
 if auth.uid() is null or coalesce(auth.jwt()->>'aal','')<>'aal2' then raise exception 'ACCESS_DENIED: Authenticator verification required.' using errcode='42501';end if;
 select * into w from public.bb_workspaces where owner_id=auth.uid();
 if not found or w.state<>'READY' then raise exception 'SETUP: Finish the verified database import.';end if;
 return jsonb_build_object('ownerId',w.owner_id,'version',w.version,'day',to_char(current_timestamp at time zone coalesce(w.properties->>'DATA_TIMEZONE','Asia/Manila'),'YYYY-MM-DD'));
end $$;
revoke all on function public.bb_read_version() from public,anon;
grant execute on function public.bb_read_version() to authenticated;
commit;
