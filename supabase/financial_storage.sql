begin;
create table if not exists public.bb_workspaces (
 owner_id uuid primary key references auth.users(id),
 source_sheet_id text not null,
 state text not null default 'STAGING' check (state in ('STAGING','READY','READ_ONLY')),
 version bigint not null default 1 check(version>0),
 properties jsonb not null default '{}'::jsonb check(jsonb_typeof(properties)='object'),
 source_hash text not null,
 updated_at timestamptz not null default now()
);
create table if not exists public.bb_records (
 owner_id uuid not null references public.bb_workspaces(owner_id),
 entity text not null check(entity in ('LoanCalendar','Loans','LoanSchedules','LoanPayments','LoanAllocations','Accounts','Cards','Transactions','Statements','BankPayments','PaymentAllocations','People','Shares','Repayments','InstallmentPlans','SavedViews','Settings','Labels','ReportConfig','SheetBaseline','ImportBatches','ImportRows','ImportHistory','AuditHistory','Operations')),
 id text not null check(length(id) between 1 and 120),
 slot integer not null check(slot between 2 and 100002),
 data jsonb not null check(jsonb_typeof(data)='object' and data->>'id'=id and octet_length(data::text)<=100000),
 primary key(owner_id,entity,id),
 unique(owner_id,entity,slot)
);
create table if not exists public.bb_mutations (
 owner_id uuid not null references public.bb_workspaces(owner_id),
 id text not null check(length(id) between 16 and 100),
 request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 result jsonb not null,
 version bigint not null,
 created_at timestamptz not null default now(),
 primary key(owner_id,id)
);
create index if not exists bb_account_records on public.bb_records(owner_id,entity,(data->>'accountId'));
create index if not exists bb_transaction_dates on public.bb_records(owner_id,(data->>'transactionDate'),id) where entity='Transactions';
create index if not exists bb_review_status on public.bb_records(owner_id,(data->>'reviewStatus')) where entity='Transactions';
create unique index if not exists bb_source_unique on public.bb_records(owner_id,(data->>'sourceKey')) where entity='Transactions' and coalesce(data->>'sourceKey','')<>'';
create unique index if not exists bb_config_key_unique on public.bb_records(owner_id,entity,(data->>'key')) where entity in ('Settings','Labels','ReportConfig');
alter table public.bb_workspaces enable row level security;
alter table public.bb_records enable row level security;
alter table public.bb_mutations enable row level security;
revoke all on public.bb_workspaces,public.bb_records,public.bb_mutations from public,anon,authenticated;
grant select on public.bb_workspaces,public.bb_records,public.bb_mutations to authenticated;
grant select,insert,update,delete on public.bb_workspaces,public.bb_records,public.bb_mutations to service_role;
drop policy if exists bb_owner_read on public.bb_workspaces;
create policy bb_owner_read on public.bb_workspaces for select to authenticated using(owner_id=(select auth.uid()) and (select auth.jwt()->>'aal')='aal2');
drop policy if exists bb_owner_read on public.bb_records;
create policy bb_owner_read on public.bb_records for select to authenticated using(owner_id=(select auth.uid()) and (select auth.jwt()->>'aal')='aal2');
drop policy if exists bb_owner_read on public.bb_mutations;
create policy bb_owner_read on public.bb_mutations for select to authenticated using(owner_id=(select auth.uid()) and (select auth.jwt()->>'aal')='aal2');

create or replace function public.bb_snapshot(p_full boolean default false,p_request_id text default '',p_hash text default '') returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare w public.bb_workspaces; m public.bb_mutations; records jsonb; who uuid:=auth.uid();
begin
 if who is null or coalesce(auth.jwt()->>'aal','')<>'aal2' then raise exception 'ACCESS_DENIED: Authenticator verification required.' using errcode='42501';end if;
 select * into w from public.bb_workspaces where owner_id=who;
 if not found or w.state<>'READY' then raise exception 'SETUP: Finish the verified database import.';end if;
 if p_request_id<>'' then
  select * into m from public.bb_mutations where owner_id=who and id=p_request_id;
  if found then
   if m.request_hash<>p_hash then raise exception 'CONFLICT: Retry the original request.';end if;
   return jsonb_build_object('replayed',true,'result',m.result);
  end if;
 end if;
 select coalesce(jsonb_object_agg(entity,items),'{}'::jsonb) into records from (
  select entity,jsonb_agg(data||jsonb_build_object('_slot',slot) order by slot) items from public.bb_records
  where owner_id=who and (p_full or entity not in ('SheetBaseline','AuditHistory','Operations','ImportRows') or entity='Operations' and data->>'state' not in ('DONE','CANCELLED') or entity='Operations' and id=p_request_id)
  group by entity
 ) r;
 return jsonb_build_object('ownerId',w.owner_id,'sourceSheetId',w.source_sheet_id,'version',w.version,'properties',w.properties,'tables',records,'maxSlots',(select coalesce(jsonb_object_agg(entity,last_slot),'{}'::jsonb) from (select entity,max(slot) last_slot from public.bb_records where owner_id=w.owner_id group by entity) z),'sourceHash',w.source_hash);
end $$;
revoke all on function public.bb_snapshot(boolean,text,text) from public,anon;
grant execute on function public.bb_snapshot(boolean,text,text) to authenticated;

create or replace function public.bb_worker_snapshot(p_owner uuid,p_full boolean default false) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare w public.bb_workspaces; records jsonb;
begin
 if current_user<>'service_role' then raise exception 'ACCESS_DENIED: Server access required.' using errcode='42501';end if;
 select * into w from public.bb_workspaces where owner_id=p_owner and state='READY';
 if not found then raise exception 'SETUP: Workspace is not ready.';end if;
 select coalesce(jsonb_object_agg(entity,items),'{}'::jsonb) into records from (
  select entity,jsonb_agg(data||jsonb_build_object('_slot',slot) order by slot) items from public.bb_records
  where owner_id=p_owner and (p_full or entity not in ('SheetBaseline','AuditHistory','Operations','ImportRows') or entity='Operations' and data->>'state' not in ('DONE','CANCELLED')) group by entity
 ) r;
 return jsonb_build_object('ownerId',w.owner_id,'sourceSheetId',w.source_sheet_id,'version',w.version,'properties',w.properties,'tables',records,'maxSlots',(select coalesce(jsonb_object_agg(entity,last_slot),'{}'::jsonb) from (select entity,max(slot) last_slot from public.bb_records where owner_id=w.owner_id group by entity) z),'sourceHash',w.source_hash);
end $$;
revoke all on function public.bb_worker_snapshot(uuid,boolean) from public,anon,authenticated;
grant execute on function public.bb_worker_snapshot(uuid,boolean) to service_role;

create or replace function public.bb_commit(p_owner uuid,p_session text,p_version bigint,p_id text,p_hash text,p_changes jsonb,p_properties jsonb,p_result jsonb,p_mode text default 'user') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare w public.bb_workspaces; m public.bb_mutations; c jsonb; b jsonb; a jsonb; existing jsonb; ent text; rid text; pos integer; result jsonb;
begin
 if current_user<>'service_role' then raise exception 'ACCESS_DENIED: Server access required.' using errcode='42501';end if;
 if p_owner is null or p_mode is null or p_mode not in ('user','automation') or p_id is null or p_id!~'^[a-zA-Z0-9_-]{16,100}$' or p_hash is null or p_hash!~'^[a-f0-9]{64}$' then raise exception 'VALIDATION: Invalid operation identity.';end if;
 if p_mode='user' and not exists(select 1 from public.cardbills_sessions where id=p_session and user_id=p_owner and expires_at>now()) then raise exception 'ACCESS_DENIED: Sign in again.' using errcode='42501';end if;
 select * into w from public.bb_workspaces where owner_id=p_owner for update;
 if not found or w.state<>'READY' then raise exception 'SETUP: Workspace is not writable.';end if;
 if p_mode='automation' and coalesce(w.properties->>'DATABASE_AUTOMATION','false')<>'true' then raise exception 'ACCESS_DENIED: Automation is disabled.' using errcode='42501';end if;
 select * into m from public.bb_mutations where owner_id=p_owner and id=p_id;
 if found then
  if m.request_hash<>p_hash then raise exception 'CONFLICT: Retry the original request.';end if;
  return m.result;
 end if;
 if w.version<>p_version then raise exception 'CONFLICT: Records changed. Refresh before saving.';end if;
 if p_changes is null or jsonb_typeof(p_changes)<>'array' or jsonb_array_length(p_changes)>6000 or octet_length(p_changes::text)>8000000 or p_properties is null or jsonb_typeof(p_properties)<>'object' or octet_length(p_properties::text)>64000 or p_result is null or octet_length(p_result::text)>4000000 then raise exception 'LIMIT: Invalid or excessive batch.';end if;
 if exists(select 1 from jsonb_array_elements(p_changes) x group by x->>'entity',x->>'slot' having count(*)>1) then raise exception 'VALIDATION: Duplicate record position.';end if;
 for c in select value from jsonb_array_elements(p_changes) loop
  ent:=c->>'entity';pos:=(c->>'slot')::integer;b:=nullif(c->'before','null'::jsonb);a:=nullif(c->'after','null'::jsonb);
  if ent is null or pos is null or pos<2 then raise exception 'VALIDATION: Invalid record position.';end if;
  if p_mode='automation' and (ent not in ('Statements','LoanCalendar') or (ent='Statements' and (b is null or a is null or (a-array['calendarId','eventId','syncedAt','fingerprint','syncError','attempts','nextRetry','revision','updatedAt']) is distinct from (b-array['calendarId','eventId','syncedAt','fingerprint','syncError','attempts','nextRetry','revision','updatedAt'])) )) then raise exception 'ACCESS_DENIED: Invalid synchronization change.' using errcode='42501';end if;
  if a is null and ent<>'ImportRows' then raise exception 'VALIDATION: Financial history must be retained.';end if;
  if b is not null then
   rid:=b->>'id';select data into existing from public.bb_records where owner_id=p_owner and entity=ent and id=rid and slot=pos;
   if not found or existing is distinct from b then raise exception 'CONFLICT: Record revision changed.';end if;
   if ent in ('AuditHistory','ImportHistory') then raise exception 'VALIDATION: Historical records are immutable.';end if;
   if a is null or a->>'id'<>rid then
    if ent<>'ImportRows' then raise exception 'VALIDATION: Stable identity is immutable.';end if;
    delete from public.bb_records where owner_id=p_owner and entity=ent and id=rid;
    if a is not null then insert into public.bb_records(owner_id,entity,id,slot,data) values(p_owner,ent,a->>'id',pos,a);end if;
   else
    if ent not in ('Operations','ImportRows','SheetBaseline') and (a->>'revision')::bigint<(b->>'revision')::bigint then raise exception 'VALIDATION: Revision cannot decrease.';end if;
    update public.bb_records set data=a where owner_id=p_owner and entity=ent and id=rid;
   end if;
  elsif a is not null then
   insert into public.bb_records(owner_id,entity,id,slot,data) values(p_owner,ent,a->>'id',pos,a);
  end if;
 end loop;
 if p_mode='automation' and (p_properties-array['LAST_SYNC','LAST_BACKUP','LAST_BACKUP_VERSION','BACKUP_ERROR','AUTOMATION_ERROR']) is distinct from (w.properties-array['LAST_SYNC','LAST_BACKUP','LAST_BACKUP_VERSION','BACKUP_ERROR','AUTOMATION_ERROR']) then raise exception 'ACCESS_DENIED: Invalid automation settings.' using errcode='42501';end if;
 update public.bb_workspaces set version=version+1,properties=p_properties,updated_at=now() where owner_id=p_owner returning version into p_version;
 result:=p_result||jsonb_build_object('databaseVersion',p_version);
 insert into public.bb_mutations(owner_id,id,request_hash,result,version) values(p_owner,p_id,p_hash,result,p_version);
 return result;
end $$;
revoke all on function public.bb_commit(uuid,text,bigint,text,text,jsonb,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.bb_commit(uuid,text,bigint,text,text,jsonb,jsonb,jsonb,text) to service_role;
notify pgrst,'reload schema';
commit;
