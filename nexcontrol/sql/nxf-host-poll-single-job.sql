-- Claim one host job at a time. Long jobs no longer reserve two extra jobs.
create or replace function public.nxf_host_poll(
  p_agent_id uuid,
  p_agent_key text,
  p_meta jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','extensions'
as $$
declare
  v_agent public.nxc_host_agents%rowtype;
  v_jobs jsonb;
begin
  select * into v_agent
  from public.nxc_host_agents
  where id=p_agent_id and enabled=true;

  if not found
     or v_agent.key_hash <> encode(extensions.digest(coalesce(p_agent_key,''),'sha256'),'hex')
  then
    raise exception 'unauthorized_agent';
  end if;

  update public.nxc_host_agents
  set hostname=coalesce(nullif(p_meta->>'hostname',''),hostname),
      os=coalesce(nullif(p_meta->>'os',''),os),
      kernel=coalesce(nullif(p_meta->>'kernel',''),kernel),
      arch=coalesce(nullif(p_meta->>'arch',''),arch),
      version=coalesce(nullif(p_meta->>'version',''),version),
      capabilities=case when p_meta ? 'capabilities' then p_meta->'capabilities' else capabilities end,
      last_seen_at=now(),
      updated_at=now()
  where id=p_agent_id;

  update public.nxc_host_jobs
  set status='pending',claimed_at=null,claim_expires_at=null,updated_at=now()
  where agent_id=p_agent_id and status='claimed' and claim_expires_at < now();

  with picked as (
    select id
    from public.nxc_host_jobs
    where agent_id=p_agent_id and status='pending'
    order by created_at
    for update skip locked
    limit 1
  ), upd as (
    update public.nxc_host_jobs j
    set status='claimed',
        claimed_at=now(),
        claim_expires_at=now()+interval '90 seconds',
        updated_at=now()
    from picked
    where j.id=picked.id
    returning j.id,j.kind,j.payload
  )
  select coalesce(
    jsonb_agg(jsonb_build_object('id',id,'kind',kind,'payload',payload)),
    '[]'::jsonb
  )
  into v_jobs from upd;

  return jsonb_build_object('ok',true,'jobs',v_jobs);
end
$$;

revoke all on function public.nxf_host_poll(uuid,text,jsonb) from public;
revoke all on function public.nxf_host_poll(uuid,text,jsonb) from authenticated;
grant execute on function public.nxf_host_poll(uuid,text,jsonb) to anon, service_role;
