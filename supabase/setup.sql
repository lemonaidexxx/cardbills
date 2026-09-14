create table if not exists public.cardbills_sessions (
  id text primary key check (id ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_box text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists cardbills_sessions_expiry on public.cardbills_sessions(expires_at);
alter table public.cardbills_sessions enable row level security;
revoke all on table public.cardbills_sessions from public, anon, authenticated;
grant select, insert, delete on public.cardbills_sessions to service_role;

create table if not exists public.cardbills_attempts (
  key text primary key check (key ~ '^[a-f0-9]{64}$'),
  count integer not null,
  expires_at timestamptz not null
);
alter table public.cardbills_attempts enable row level security;
revoke all on table public.cardbills_attempts from public, anon, authenticated;
grant select, insert, update, delete on public.cardbills_attempts to service_role;

create or replace function public.cardbills_take_attempt(p_key text, p_limit integer, p_seconds integer)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  attempt_count integer;
begin
  if p_key !~ '^[a-f0-9]{64}$' or p_limit < 1 or p_limit > 200 or p_seconds < 1 or p_seconds > 3600 then
    raise exception 'Invalid rate limit';
  end if;
  delete from public.cardbills_attempts where expires_at < now() - interval '1 hour';
  delete from public.cardbills_sessions where expires_at < now();
  insert into public.cardbills_attempts(key, count, expires_at)
  values(p_key, 1, now() + make_interval(secs => p_seconds))
  on conflict(key) do update
  set count = case when public.cardbills_attempts.expires_at <= now() then 1 else least(public.cardbills_attempts.count + 1, 1000000) end,
      expires_at = case when public.cardbills_attempts.expires_at <= now() then now() + make_interval(secs => p_seconds) else public.cardbills_attempts.expires_at end
  returning count into attempt_count;
  return attempt_count <= p_limit;
end;
$$;
revoke all on function public.cardbills_take_attempt(text, integer, integer) from public, anon, authenticated;
grant execute on function public.cardbills_take_attempt(text, integer, integer) to service_role;
