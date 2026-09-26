-- NexForge multi-agent coordination schema.
-- Applied to Supabase project NexCode on 2026-09-26.

create table if not exists public.nxf_workers (
  slug text primary key,
  display_name text not null,
  provider text not null,
  session_id text,
  status text not null default 'online',
  capabilities jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint nxf_workers_slug_chk check (slug ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
);

create table if not exists public.nxf_resource_locks (
  resource_key text primary key,
  worker text not null references public.nxf_workers(slug) on delete cascade,
  task_id uuid references public.nxc_task_queue(id) on delete set null,
  lease_expires_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.nxf_mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  token_hash text not null unique,
  worker_slug text not null references public.nxf_workers(slug) on delete cascade,
  scopes text[] not null default '{}'::text[],
  active boolean not null default true,
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists nxf_resource_locks_worker_idx
  on public.nxf_resource_locks(worker, lease_expires_at);
create index if not exists nxf_mcp_tokens_worker_idx
  on public.nxf_mcp_tokens(worker_slug) where active;
create index if not exists nxc_task_queue_executor_status_idx
  on public.nxc_task_queue(executor, status, priority desc, available_at);

alter table public.nxf_workers enable row level security;
alter table public.nxf_resource_locks enable row level security;
alter table public.nxf_mcp_tokens enable row level security;

revoke all on public.nxf_workers from anon, authenticated;
revoke all on public.nxf_resource_locks from anon, authenticated;
revoke all on public.nxf_mcp_tokens from anon, authenticated;

grant select, insert, update, delete on public.nxf_workers to service_role;
grant select, insert, update, delete on public.nxf_resource_locks to service_role;
grant select, insert, update, delete on public.nxf_mcp_tokens to service_role;

alter table public.nxc_task_queue drop constraint if exists nxc_task_queue_executor_check;
alter table public.nxc_task_queue
  add constraint nxc_task_queue_executor_check
  check (executor = any (array[
    'chatgpt'::text,
    'nexcontrol_agent'::text,
    'claude'::text,
    'shared'::text,
    'any'::text
  ]));

-- The live RPC definitions are also backed up in the synced Edge Function source.
-- Do not commit plaintext MCP capability tokens.
