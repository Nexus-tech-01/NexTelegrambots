-- Keep NexForge host visibility alive while long jobs execute.
create or replace function public.nxf_host_heartbeat(
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

  return jsonb_build_object('ok',true,'at',now());
end
$$;

revoke all on function public.nxf_host_heartbeat(uuid,text,jsonb) from public;
revoke all on function public.nxf_host_heartbeat(uuid,text,jsonb) from authenticated;
grant execute on function public.nxf_host_heartbeat(uuid,text,jsonb) to anon, service_role;
