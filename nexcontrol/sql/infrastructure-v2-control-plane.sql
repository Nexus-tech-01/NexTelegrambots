-- NexControl Infrastructure v2 control-plane snapshot
-- Source of truth for the functions introduced by the Infrastructure v2 rollout.
-- Apply only to the NexCode Supabase project after reviewing against current production.
-- Server-only admin RPCs remain executable by service_role only.

-- nxc_private.deployment_tick
CREATE OR REPLACE FUNCTION nxc_private.deployment_tick()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'nxc_private'
AS $function$
declare
  r record;
  p public.nxc_projects%rowtype;
  prof public.nxc_deploy_profiles%rowtype;
  src public.nxc_project_sources%rowtype;
  w public.nxc_repo_watches%rowtype;
  a public.nxc_host_agents%rowtype;
  planrow public.nxc_deploy_plans%rowtype;
  v_plan uuid;
  v_job uuid;
  v_payload jsonb;
  v_health jsonb;
  v_report jsonb;
  v_prev uuid;
  v_total int;
  v_fresh int;
  v_bad int;
  v_completed timestamptz;
  v_queued int := 0;
  v_promoted int := 0;
  v_failed int := 0;
  v_rolled int := 0;
  v_checking int := 0;
begin
  -- Harvest rollback jobs first.
  for r in
    select d.id deployment_id,d.project_id,d.metadata,
           j.status job_status,j.result,j.error,j.completed_at
    from public.nxc_deployments d
    join public.nxc_host_jobs j
      on j.id=nullif(d.metadata->>'rollbackJobId','')::uuid
    where d.status='deploying'
      and d.metadata->>'phase'='rollback'
      and j.status in ('done','failed')
    for update of d skip locked
  loop
    v_report := nxc_private.last_json_line(r.result->>'stdout');
    if r.job_status='done'
       and coalesce((r.result->>'code')::int,1)=0
       and coalesce((v_report->>'ok')::boolean,false) then
      update public.nxc_deployments
      set status='rolled_back',completed_at=now(),
          metadata=metadata || jsonb_build_object('rollbackReport',v_report,'phase','done'),
          error_summary=coalesce(metadata->>'rollbackReason','post_deploy_health_failed')
      where id=r.deployment_id;
      update public.nxc_deployment_steps
      set status=case when step_key='rollback' then 'success' when status='pending' then 'skipped' else status end,
          completed_at=case when step_key='rollback' then now() else completed_at end
      where deployment_id=r.deployment_id;
      update public.nxc_projects set status='running',health_status='degraded',updated_at=now()
      where id=r.project_id;
      v_rolled := v_rolled+1;
    else
      update public.nxc_deployments
      set status='failed',completed_at=now(),
          error_summary=left(coalesce(r.error,v_report->>'error',r.result->>'stderr','rollback_failed'),1000),
          metadata=metadata || jsonb_build_object('rollbackReport',coalesce(v_report,'{}'::jsonb),'phase','done')
      where id=r.deployment_id;
      update public.nxc_deployment_steps
      set status=case when step_key='rollback' then 'failed' when status='pending' then 'skipped' else status end,
          completed_at=case when step_key='rollback' then now() else completed_at end
      where deployment_id=r.deployment_id;
      update public.nxc_projects set status='failed',health_status='unhealthy',updated_at=now()
      where id=r.project_id;
      v_failed := v_failed+1;
    end if;
  end loop;

  -- Harvest deploy executor jobs.
  for r in
    select d.id deployment_id,d.project_id,d.metadata,
           j.status job_status,j.result,j.error,j.completed_at
    from public.nxc_deployments d
    join public.nxc_host_jobs j
      on j.id=nullif(d.metadata->>'hostJobId','')::uuid
    where d.status='deploying'
      and coalesce(d.metadata->>'phase','deploy')='deploy'
      and j.status in ('done','failed')
    for update of d skip locked
  loop
    v_report := nxc_private.last_json_line(r.result->>'stdout');
    if r.job_status='done'
       and coalesce((r.result->>'code')::int,1)=0
       and coalesce((v_report->>'ok')::boolean,false) then
      update public.nxc_deployments
      set status='checking',
          artifact_ref=v_report->>'releasePath',
          metadata=metadata || jsonb_build_object(
            'executorReport',v_report,
            'executorCompletedAt',coalesce(r.completed_at,now()),
            'previousTarget',v_report->>'previousTarget',
            'phase','health'
          )
      where id=r.deployment_id;
      update public.nxc_deployment_steps
      set status=case
        when step_key='rollback' then 'pending'
        when step_key='health' then 'running'
        else 'success' end,
        started_at=coalesce(started_at,now()),
        completed_at=case when step_key not in ('health','rollback') then now() else completed_at end
      where deployment_id=r.deployment_id;
      v_checking := v_checking+1;
    else
      if coalesce((v_report->'rollback'->>'ok')::boolean,false) then
        update public.nxc_deployments
        set status='rolled_back',completed_at=now(),
            error_summary=left(coalesce(v_report->>'error',r.error,r.result->>'stderr','deploy_failed'),1000),
            metadata=metadata || jsonb_build_object('executorReport',coalesce(v_report,'{}'::jsonb),'phase','done')
        where id=r.deployment_id;
        update public.nxc_deployment_steps
        set status=case when step_key='rollback' then 'success' when status='pending' then 'failed' else status end,
            completed_at=now()
        where deployment_id=r.deployment_id;
        update public.nxc_projects set status='running',health_status='degraded',updated_at=now()
        where id=r.project_id;
        v_rolled := v_rolled+1;
      else
        update public.nxc_deployments
        set status='failed',completed_at=now(),
            error_summary=left(coalesce(v_report->>'error',r.error,r.result->>'stderr','deploy_failed'),1000),
            metadata=metadata || jsonb_build_object('executorReport',coalesce(v_report,'{}'::jsonb),'phase','done')
        where id=r.deployment_id;
        update public.nxc_deployment_steps
        set status=case when status in ('pending','running') then 'failed' else status end,
            completed_at=case when status in ('pending','running') then now() else completed_at end
        where deployment_id=r.deployment_id;
        update public.nxc_projects set status='failed',health_status='unhealthy',updated_at=now()
        where id=r.project_id;
        v_failed := v_failed+1;
      end if;
    end if;
  end loop;

  -- Promote checked deployments or initiate rollback when control-plane health fails.
  for r in
    select d.*
    from public.nxc_deployments d
    where d.status='checking'
    order by d.created_at
    for update skip locked
    limit 20
  loop
    select * into prof from public.nxc_deploy_profiles where project_id=r.project_id;
    v_completed := nullif(r.metadata->>'executorCompletedAt','')::timestamptz;

    select count(*)::int,
           count(*) filter (where last_checked_at is not null and last_checked_at >= v_completed)::int,
           count(*) filter (
             where last_checked_at is not null and last_checked_at >= v_completed
               and last_status <> 'healthy'
           )::int
    into v_total,v_fresh,v_bad
    from public.nxc_health_checks
    where project_id=r.project_id and enabled=true;

    if prof.health_gate_required=false or (v_total>0 and v_fresh=v_total and v_bad=0) then
      update public.nxc_deployments
      set status='healthy',completed_at=now(),promoted_at=now(),
          metadata=metadata || jsonb_build_object('phase','done','promotedAt',now())
      where id=r.id;
      update public.nxc_deployment_steps
      set status=case when step_key='rollback' then 'skipped' else 'success' end,
          completed_at=coalesce(completed_at,now())
      where deployment_id=r.id;
      update public.nxc_projects set status='running',health_status='healthy',updated_at=now()
      where id=r.project_id;
      v_promoted := v_promoted+1;
      continue;
    end if;

    if v_completed is not null and (
         now()-v_completed > interval '3 minutes'
         or (v_total>0 and v_fresh=v_total and v_bad>0 and now()-v_completed > interval '45 seconds')
       ) then
      select * into p from public.nxc_projects where id=r.project_id;
      select nxc_private.last_json_line('{}') into v_report;
      select coalesce(jsonb_agg(jsonb_build_object(
        'name',h.name,'type',h.check_type,'target',h.target,'config',h.config,
        'enabled',h.enabled,'timeout',h.timeout_seconds
      ) order by h.name),'[]'::jsonb)
      into v_health
      from public.nxc_health_checks h
      where h.project_id=r.project_id and h.enabled=true;

      if nullif(r.metadata->>'previousTarget','') is null then
        update public.nxc_deployments
        set status='failed',completed_at=now(),error_summary='post_deploy_health_failed_no_rollback_target',
            metadata=metadata || jsonb_build_object('phase','done')
        where id=r.id;
        update public.nxc_projects set status='failed',health_status='unhealthy',updated_at=now()
        where id=r.project_id;
        v_failed := v_failed+1;
      else
        select ha.* into a
        from public.nxc_nodes n join public.nxc_host_agents ha on ha.id=n.host_agent_id
        where n.id=p.node_id;
        if a.id is null or a.enabled=false or a.last_seen_at < now()-interval '3 minutes' then
          continue;
        end if;
        v_payload := jsonb_build_object(
          'operation','rollback',
          'currentPath',prof.current_path,
          'previousTarget',r.metadata->>'previousTarget',
          'service',prof.service_name,
          'healthChecks',v_health
        );
        insert into public.nxc_host_jobs(agent_id,kind,payload,status,created_at,updated_at)
        values(
          a.id,'exec',
          jsonb_build_object(
            'command',nxc_private.executor_command(v_payload),
            'cwd','/','timeout',300,'collector','nxc-release-rollback-v1','deploymentId',r.id
          ),
          'pending',now(),now()
        ) returning id into v_job;
        update public.nxc_deployments
        set status='deploying',
            metadata=metadata || jsonb_build_object(
              'phase','rollback','rollbackJobId',v_job,'rollbackReason','post_deploy_health_failed'
            )
        where id=r.id;
        update public.nxc_deployment_steps
        set status=case when step_key='health' then 'failed' when step_key='rollback' then 'running' else status end,
            completed_at=case when step_key='health' then now() else completed_at end,
            started_at=case when step_key='rollback' then now() else started_at end
        where deployment_id=r.id;
      end if;
    end if;
  end loop;

  -- Start queued deployments.
  for r in
    select d.*
    from public.nxc_deployments d
    where d.status='queued'
    order by d.created_at
    for update skip locked
    limit 4
  loop
    select * into p from public.nxc_projects where id=r.project_id and archived_at is null;
    if not found then
      update public.nxc_deployments set status='canceled',completed_at=now(),error_summary='project_not_found' where id=r.id;
      continue;
    end if;
    select * into prof from public.nxc_deploy_profiles where project_id=p.id;
    select * into src from public.nxc_project_sources where project_id=p.id;
    select * into w from public.nxc_repo_watches
      where repo_owner=p.repo_owner and repo_name=p.repo_name
        and branch=coalesce(p.auto_deploy_branch,p.repo_default_branch,'main')
      limit 1;
    select ha.* into a
    from public.nxc_nodes n join public.nxc_host_agents ha on ha.id=n.host_agent_id
    where n.id=p.node_id;

    if r.commit_sha is null or r.commit_sha !~ '^[0-9a-fA-F]{40}$' then
      update public.nxc_deployments set status='canceled',completed_at=now(),error_summary='invalid_commit_sha' where id=r.id; continue;
    end if;
    if prof.strategy is distinct from 'atomic_symlink' or prof.rollback_supported is distinct from true then
      update public.nxc_deployments set status='canceled',completed_at=now(),error_summary='runtime_not_verified' where id=r.id; continue;
    end if;
    if src.verified is distinct from true or src.component_path is null then
      update public.nxc_deployments set status='canceled',completed_at=now(),error_summary='source_not_verified' where id=r.id; continue;
    end if;
    if src.source_type='bundle_component' and src.verified_commit_sha is distinct from r.commit_sha then
      update public.nxc_deployments set status='canceled',completed_at=now(),error_summary='source_not_verified_for_commit' where id=r.id; continue;
    end if;
    if w.id is null or w.active=false or w.blocked=true then
      update public.nxc_deployments set status='canceled',completed_at=now(),
        error_summary='repo_watch_blocked:'||coalesce(w.blocked_reason,'not_ready') where id=r.id; continue;
    end if;
    if a.id is null or a.enabled=false or a.last_seen_at < now()-interval '3 minutes' then
      update public.nxc_deployments
      set metadata=metadata || jsonb_build_object('waitingReason','agent_offline','waitingAt',now())
      where id=r.id;
      continue;
    end if;

    v_plan := nxc_private.build_deploy_plan(p.id,r.commit_sha,r.trigger_type,'deployment:'||r.id::text);
    select * into planrow from public.nxc_deploy_plans where id=v_plan;
    if planrow.status<>'ready' then
      update public.nxc_deployments
      set status='canceled',completed_at=now(),error_summary='plan_blocked:'||coalesce(planrow.blocked_reason,'unknown'),
          metadata=metadata || jsonb_build_object('planId',v_plan)
      where id=r.id;
      continue;
    end if;

    select coalesce(jsonb_agg(jsonb_build_object(
      'name',h.name,'type',h.check_type,'target',h.target,'config',h.config,
      'enabled',h.enabled,'timeout',h.timeout_seconds
    ) order by h.name),'[]'::jsonb)
    into v_health
    from public.nxc_health_checks h
    where h.project_id=p.id and h.enabled=true;

    v_payload := jsonb_build_object(
      'operation','deploy',
      'deploymentId',r.id,
      'projectSlug',p.slug,
      'repoOwner',p.repo_owner,
      'repoName',p.repo_name,
      'commitSha',r.commit_sha,
      'sourceType',src.source_type,
      'componentPath',src.component_path,
      'bundlePartsPattern',src.bundle_parts_pattern,
      'bundlePartCount',src.bundle_part_count,
      'releasePath',planrow.plan->>'releasePath',
      'currentPath',prof.current_path,
      'service',prof.service_name,
      'installCommand',prof.install_command,
      'buildCommand',prof.build_command,
      'predeployCommand',prof.predeploy_command,
      'postdeployCommand',prof.postdeploy_command,
      'healthChecks',v_health
    );

    insert into public.nxc_host_jobs(agent_id,kind,payload,status,created_at,updated_at)
    values(
      a.id,'exec',
      jsonb_build_object(
        'command',nxc_private.executor_command(v_payload),
        'cwd','/','timeout',1800,'collector','nxc-release-executor-v1',
        'deploymentId',r.id,'projectId',p.id,'commitSha',r.commit_sha
      ),
      'pending',now(),now()
    ) returning id into v_job;

    select id into v_prev
    from public.nxc_deployments
    where project_id=p.id and status='healthy' and id<>r.id
    order by promoted_at desc nulls last,created_at desc
    limit 1;

    update public.nxc_deployments
    set status='deploying',started_at=coalesce(started_at,now()),previous_deployment_id=v_prev,
        metadata=(metadata-'waitingReason') || jsonb_build_object(
          'phase','deploy','hostJobId',v_job,'planId',v_plan,
          'executorCommit','21ecaeeaacb3f14bd947c5d67f3222fa9555ac87',
          'executorSha256','f570f3be42b1d5bcfa015ae3812b0614a2696261a7e5fbf8677c80070a7704e6'
        )
    where id=r.id;

    insert into public.nxc_deployment_steps(deployment_id,step_key,label,position,status,metadata,created_at)
    select r.id,
           coalesce(x.value->>'key','step-'||x.ordinality::text),
           coalesce(x.value->>'label',x.value->>'key','Step'),
           x.ordinality::int,
           case when x.value->>'key'='source' then 'running' else 'pending' end,
           x.value,now()
    from jsonb_array_elements(planrow.plan->'steps') with ordinality x(value,ordinality)
    on conflict (deployment_id,step_key) do nothing;

    update public.nxc_projects set status='deploying',updated_at=now() where id=p.id;
    v_queued := v_queued+1;
  end loop;

  return jsonb_build_object(
    'ok',true,'started',v_queued,'checking',v_checking,'promoted',v_promoted,
    'failed',v_failed,'rolledBack',v_rolled,'at',now()
  );
end
$function$;

-- nxc_private.executor_command
CREATE OR REPLACE FUNCTION nxc_private.executor_command(p_payload jsonb)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_b64 text;
begin
  v_b64 := replace(encode(convert_to(p_payload::text,'UTF8'),'base64'), E'\n','');
  return
    'set -euo pipefail; D=/opt/nex/control; F=$D/nexcontrol-release-executor.py; T=$D/.executor.tmp; '||
    'mkdir -p "$D"; '||
    'curl -fsSL --retry 3 --connect-timeout 10 '||
    'https://raw.githubusercontent.com/Nexus-tech-01/NexTelegrambots/21ecaeeaacb3f14bd947c5d67f3222fa9555ac87/ops/nexcontrol-release-executor.py '||
    '-o "$T"; '||
    'echo "f570f3be42b1d5bcfa015ae3812b0614a2696261a7e5fbf8677c80070a7704e6  $T" | sha256sum -c - >/dev/null; '||
    'install -m 0755 "$T" "$F"; rm -f "$T"; '||
    'python3 "$F" --payload '||quote_literal(v_b64);
end
$function$;

-- nxc_private.host_onboarding_tick
CREATE OR REPLACE FUNCTION nxc_private.host_onboarding_tick()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  r record;
  v_count integer := 0;
  v_slug text;
begin
  for r in
    select a.*
    from public.nxc_host_agents a
    where a.enabled=true
      and not exists(select 1 from public.nxc_nodes n where n.host_agent_id=a.id)
  loop
    v_slug := regexp_replace(lower(coalesce(nullif(r.hostname,''),'vps')),'[^a-z0-9-]+','-','g');
    v_slug := trim(both '-' from v_slug) || '-' || left(replace(r.id::text,'-',''),6);
    insert into public.nxc_nodes(
      host_agent_id,slug,display_name,environment,provider,region,scheduling_enabled,
      maintenance_mode,labels,resource_profile,notes,created_at,updated_at
    ) values (
      r.id,v_slug,coalesce(nullif(r.name,''),nullif(r.hostname,''),'NexControl Host'),
      'production','vps',null,true,false,
      jsonb_build_object('source','host-agent-registration'),
      jsonb_build_object('arch',r.arch,'agentVersion',r.version),
      null,now(),now()
    );
    v_count := v_count+1;
  end loop;
  return jsonb_build_object('ok',true,'createdNodes',v_count,'at',now());
end
$function$;

-- nxc_private.last_json_line
CREATE OR REPLACE FUNCTION nxc_private.last_json_line(p_text text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
declare
  m text[];
begin
  m := regexp_match(coalesce(p_text,''), E'(\\{[^\\n]+\\})\\s*$');
  if m is null then return null; end if;
  return m[1]::jsonb;
exception when others then
  return null;
end
$function$;

-- nxc_private.project_runtime_verification_tick
CREATE OR REPLACE FUNCTION nxc_private.project_runtime_verification_tick()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  r record;
  v_job uuid;
  v_cmd text;
  v_queued integer := 0;
  v_done integer := 0;
  v_failed integer := 0;
begin
  for r in
    select d.project_id,d.config,j.id job_id,j.status job_status,j.result,j.error
    from public.nxc_deploy_profiles d
    join public.nxc_host_jobs j
      on j.id=nullif(d.config->>'verificationJobId','')::uuid
    where d.rollback_supported=false
      and d.config ? 'verificationJobId'
      and j.status in ('done','failed')
  loop
    if r.job_status='done' and coalesce((r.result->>'code')::int,1)=0 then
      update public.nxc_deploy_profiles
      set rollback_supported=true,verified_at=now(),
          config=(config-'verificationJobId'-'verificationError') ||
                 jsonb_build_object('onboarding','verified','verifiedAt',now(),'verificationJobIdLast',r.job_id),
          updated_at=now()
      where project_id=r.project_id;
      v_done := v_done+1;
    else
      update public.nxc_deploy_profiles
      set rollback_supported=false,verified_at=null,
          config=(config-'verificationJobId') ||
                 jsonb_build_object('onboarding','verification_failed','verificationError',
                   left(coalesce(r.error,r.result->>'stderr','runtime_verification_failed'),1000),
                   'verificationFailedAt',now(),'verificationJobIdLast',r.job_id),
          updated_at=now()
      where project_id=r.project_id;
      v_failed := v_failed+1;
    end if;
  end loop;

  for r in
    select p.id project_id,p.slug,d.current_path,d.release_root,d.service_name,
           a.id agent_id
    from public.nxc_projects p
    join public.nxc_deploy_profiles d on d.project_id=p.id
    join public.nxc_nodes n on n.id=p.node_id
    join public.nxc_host_agents a on a.id=n.host_agent_id
    where p.archived_at is null
      and d.strategy='atomic_symlink'
      and d.rollback_supported=false
      and not (d.config ? 'verificationJobId')
      and coalesce(d.config->>'onboarding','pending_runtime_verification') <> 'verification_failed'
      and a.enabled=true
      and a.last_seen_at > now()-interval '2 minutes'
  loop
    v_cmd := 'set -euo pipefail; CURRENT='||quote_literal(r.current_path)||
             '; ROOT='||quote_literal(coalesce(r.release_root,'/opt/nex/releases'))||
             '; SERVICE='||quote_literal(r.service_name)||
             '; test -L "$CURRENT"; TARGET=$(readlink -f "$CURRENT"); test -n "$TARGET"; test -d "$TARGET"; case "$TARGET" in /opt/nex/releases/*|/opt/nex/apps/*|/opt/nex/current/*) ;; *) exit 44;; esac; '||
             'systemctl cat "$SERVICE" >/dev/null; systemctl is-active --quiet "$SERVICE"; '||
             'mkdir -p "$ROOT"; test -w "$ROOT"; printf ''{"ok":true,"target":"%s"}\n'' "$TARGET"';

    insert into public.nxc_host_jobs(agent_id,kind,payload,status,created_at,updated_at)
    values (
      r.agent_id,'exec',
      jsonb_build_object('command',v_cmd,'cwd','/','timeout',45,'collector','nxc-project-runtime-verification-v1','projectId',r.project_id),
      'pending',now(),now()
    ) returning id into v_job;

    update public.nxc_deploy_profiles
    set config=config || jsonb_build_object('verificationJobId',v_job,'onboarding','verifying'),
        updated_at=now()
    where project_id=r.project_id;
    v_queued := v_queued+1;
  end loop;

  return jsonb_build_object('ok',true,'queued',v_queued,'verified',v_done,'failed',v_failed,'at',now());
end
$function$;

-- public.nxc_admin_create_host_setup_token
CREATE OR REPLACE FUNCTION public.nxc_admin_create_host_setup_token(p_ttl_minutes integer DEFAULT 15)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
declare
  v_token text;
  v_hash text;
  v_exp timestamptz;
begin
  if p_ttl_minutes < 5 or p_ttl_minutes > 120 then
    raise exception 'invalid_ttl';
  end if;
  v_token := 'nxc_setup_' || encode(extensions.gen_random_bytes(32),'hex');
  v_hash := encode(extensions.digest(v_token,'sha256'),'hex');
  v_exp := now() + make_interval(mins=>p_ttl_minutes);
  insert into public.nxc_host_setup_tokens(token_hash,expires_at,used_at,created_at)
  values(v_hash,v_exp,null,now());
  delete from public.nxc_host_setup_tokens
  where expires_at < now()-interval '1 day';
  return jsonb_build_object('ok',true,'token',v_token,'expiresAt',v_exp);
end
$function$;

-- public.nxc_admin_create_project
CREATE OR REPLACE FUNCTION public.nxc_admin_create_project(p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_slug text := lower(trim(coalesce(p_data->>'slug','')));
  v_name text := trim(coalesce(p_data->>'name',''));
  v_owner text := trim(coalesce(p_data->>'repoOwner',''));
  v_repo text := trim(coalesce(p_data->>'repoName',''));
  v_branch text := trim(coalesce(p_data->>'branch','main'));
  v_runtime text := trim(coalesce(p_data->>'runtime','nodejs'));
  v_current text := trim(coalesce(p_data->>'currentPath',''));
  v_service text := trim(coalesce(p_data->>'serviceName',''));
  v_type text := trim(coalesce(p_data->>'projectType','application'));
  v_node uuid;
  v_conn uuid;
  v_project uuid;
  v_env uuid;
  v_head text := nullif(trim(coalesce(p_data->>'headSha','')),'');
  v_health text := nullif(trim(coalesce(p_data->>'healthUrl','')),'');
  v_source_verified boolean := coalesce((p_data->>'sourceVerified')::boolean,false);
  v_connection public.nxc_github_connections%rowtype;
begin
  if v_slug !~ '^[a-z0-9][a-z0-9._-]{1,62}$' then raise exception 'invalid_slug'; end if;
  if length(v_name)<2 or length(v_name)>120 then raise exception 'invalid_name'; end if;
  if v_owner !~ '^[A-Za-z0-9_.-]{1,100}$' or v_repo !~ '^[A-Za-z0-9_.-]{1,100}$' then raise exception 'invalid_repository'; end if;
  if v_branch !~ '^[A-Za-z0-9._/-]{1,180}$' then raise exception 'invalid_branch'; end if;
  if v_current !~ '^/opt/nex/(apps|current)/[A-Za-z0-9_./-]+$' then raise exception 'invalid_current_path'; end if;
  if v_service !~ '^[A-Za-z0-9@_.:-]+[.]service$' then raise exception 'invalid_service'; end if;
  if v_type not in ('application','worker','scheduled_job','automation','database','infrastructure') then raise exception 'invalid_project_type'; end if;
  if v_head is not null and v_head !~ '^[0-9a-fA-F]{40}$' then raise exception 'invalid_head_sha'; end if;

  v_node := nullif(p_data->>'nodeId','')::uuid;
  v_conn := nullif(p_data->>'githubConnectionId','')::uuid;
  if v_node is null or not exists(select 1 from public.nxc_nodes where id=v_node and maintenance_mode=false) then
    raise exception 'node_not_found';
  end if;
  select * into v_connection from public.nxc_github_connections where id=v_conn and is_active=true;
  if not found then raise exception 'github_connection_not_found'; end if;

  if v_connection.repository_selection='selected'
     and not coalesce(v_connection.repository_allowlist,'[]'::jsonb) ? (v_owner||'/'||v_repo) then
    raise exception 'repository_not_allowed';
  end if;

  insert into public.nxc_projects(
    slug,name,description,project_type,node_id,github_connection_id,
    repo_owner,repo_name,repo_default_branch,runtime,
    install_command,build_command,start_command,status,health_status,
    auto_deploy,auto_deploy_branch,deploy_triggers,runtime_config,labels,created_at,updated_at
  ) values (
    v_slug,v_name,nullif(p_data->>'description',''),v_type,v_node,v_conn,
    v_owner,v_repo,v_branch,v_runtime,
    nullif(p_data->>'installCommand',''),nullif(p_data->>'buildCommand',''),nullif(p_data->>'startCommand',''),
    'unknown','unknown',false,v_branch,'["push","merge"]'::jsonb,
    jsonb_build_object('serviceManager','systemd','systemdService',v_service,'workingDirectory',v_current),
    jsonb_build_object('onboardedBy','nexcontrol-infrastructure-v2'),now(),now()
  ) returning id into v_project;

  insert into public.nxc_project_environments(
    project_id,node_id,name,slug,environment_type,branch,domain,auto_deploy,deploy_triggers,config,created_at,updated_at
  ) values (
    v_project,v_node,'Production','production','production',v_branch,nullif(p_data->>'domain',''),
    false,'["push","merge"]'::jsonb,'{}'::jsonb,now(),now()
  ) returning id into v_env;

  insert into public.nxc_project_sources(
    project_id,source_type,component_path,bundle_parts_pattern,bundle_part_count,archive_format,
    verified,verified_commit_sha,verified_at,metadata,updated_at
  ) values (
    v_project,'git_root','.',null,null,null,
    v_source_verified,v_head,case when v_source_verified then now() else null end,
    jsonb_build_object('source','github','validatedBy','nexcontrol-ui'),now()
  );

  insert into public.nxc_deploy_profiles(
    project_id,strategy,release_root,current_path,service_name,
    install_command,build_command,predeploy_command,postdeploy_command,
    rollback_supported,health_gate_required,config,verified_at,updated_at
  ) values (
    v_project,'atomic_symlink','/opt/nex/releases',v_current,v_service,
    nullif(p_data->>'installCommand',''),nullif(p_data->>'buildCommand',''),
    nullif(p_data->>'predeployCommand',''),nullif(p_data->>'postdeployCommand',''),
    false,true,jsonb_build_object('onboarding','pending_runtime_verification'),null,now()
  );

  insert into public.nxc_health_checks(
    project_id,environment_id,name,check_type,target,config,interval_seconds,timeout_seconds,enabled,
    last_status,consecutive_failures,created_at,updated_at
  ) values (
    v_project,v_env,'Systemd process','process',v_service,jsonb_build_object('manager','systemd'),
    30,10,true,'unknown',0,now(),now()
  );

  if v_health is not null then
    insert into public.nxc_health_checks(
      project_id,environment_id,name,check_type,target,config,interval_seconds,timeout_seconds,enabled,
      last_status,consecutive_failures,created_at,updated_at
    ) values (
      v_project,v_env,'HTTP health','http',v_health,jsonb_build_object('scope','node-local','method','GET','expectedStatus',200),
      30,8,true,'unknown',0,now(),now()
    );
  end if;

  insert into public.nxc_repo_watches(
    github_connection_id,repo_owner,repo_name,branch,active,auto_enqueue,blocked,blocked_reason,
    last_sha,last_commit_at,last_polled_at,last_error,metadata,created_at,updated_at
  ) values (
    v_conn,v_owner,v_repo,v_branch,true,false,not v_source_verified,
    case when v_source_verified then null else 'source_unverified' end,
    v_head,null,null,null,jsonb_build_object('mode','observe','source','nexcontrol-onboarding'),now(),now()
  )
  on conflict (repo_owner,repo_name,branch) do update set
    active=true,
    github_connection_id=excluded.github_connection_id,
    updated_at=now();

  return jsonb_build_object('ok',true,'projectId',v_project,'environmentId',v_env,'slug',v_slug);
exception when unique_violation then
  raise exception 'project_or_watch_exists';
end
$function$;

-- public.nxc_admin_deployment_tick
CREATE OR REPLACE FUNCTION public.nxc_admin_deployment_tick()
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'nxc_private'
AS $function$
  select nxc_private.deployment_tick();
$function$;

-- public.nxc_admin_queue_deployment
CREATE OR REPLACE FUNCTION public.nxc_admin_queue_deployment(p_project_slug text, p_commit_sha text DEFAULT NULL::text, p_trigger_type text DEFAULT 'manual'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  p public.nxc_projects%rowtype;
  e public.nxc_project_environments%rowtype;
  w public.nxc_repo_watches%rowtype;
  s public.nxc_project_sources%rowtype;
  d public.nxc_deploy_profiles%rowtype;
  a public.nxc_host_agents%rowtype;
  v_sha text;
  v_id uuid;
begin
  select * into p from public.nxc_projects
  where slug=lower(trim(p_project_slug)) and archived_at is null;
  if not found then raise exception 'project_not_found'; end if;
  if p_trigger_type not in ('manual','system','push','merge','tag') then raise exception 'invalid_trigger'; end if;

  select * into e from public.nxc_project_environments where project_id=p.id and slug='production' limit 1;
  select * into w from public.nxc_repo_watches
  where repo_owner=p.repo_owner and repo_name=p.repo_name
    and branch=coalesce(p.auto_deploy_branch,p.repo_default_branch,'main')
  limit 1;
  select * into s from public.nxc_project_sources where project_id=p.id;
  select * into d from public.nxc_deploy_profiles where project_id=p.id;
  select ha.* into a
  from public.nxc_nodes n join public.nxc_host_agents ha on ha.id=n.host_agent_id
  where n.id=p.node_id;

  v_sha := coalesce(nullif(trim(p_commit_sha),''),w.last_sha);
  if v_sha is null or v_sha !~ '^[0-9a-fA-F]{40}$' then raise exception 'commit_sha_required'; end if;
  if w.id is null or w.active=false then raise exception 'watch_not_ready'; end if;
  if w.blocked then raise exception 'watch_blocked:%',coalesce(w.blocked_reason,'unknown'); end if;
  if s.project_id is null or s.verified is distinct from true or s.component_path is null then raise exception 'source_unverified'; end if;
  if s.source_type='bundle_component' and s.verified_commit_sha is distinct from v_sha then raise exception 'source_unverified_for_commit'; end if;
  if d.project_id is null or d.strategy is distinct from 'atomic_symlink' or d.rollback_supported is distinct from true then raise exception 'runtime_not_ready'; end if;
  if a.id is null or a.enabled=false or a.last_seen_at < now()-interval '3 minutes' then raise exception 'agent_offline'; end if;

  select id into v_id
  from public.nxc_deployments
  where project_id=p.id and commit_sha=v_sha
    and status in ('queued','fetching','building','testing','checking','deploying')
  order by created_at desc limit 1;

  if v_id is null then
    insert into public.nxc_deployments(
      project_id,environment_id,trigger_type,source_provider,branch,commit_sha,status,initiated_by,metadata,created_at
    ) values (
      p.id,e.id,p_trigger_type,'github',coalesce(p.auto_deploy_branch,p.repo_default_branch,'main'),
      v_sha,'queued','nexcontrol-ui',jsonb_build_object('queuedBy','nexcontrol-infrastructure-v2'),now()
    ) returning id into v_id;
  end if;

  return jsonb_build_object('ok',true,'deploymentId',v_id,'commitSha',v_sha);
end
$function$;

-- public.nxc_admin_retry_project_verification
CREATE OR REPLACE FUNCTION public.nxc_admin_retry_project_verification(p_project_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_id uuid;
begin
  select id into v_id from public.nxc_projects
  where slug=lower(trim(p_project_slug)) and archived_at is null;
  if v_id is null then raise exception 'project_not_found'; end if;

  update public.nxc_deploy_profiles
  set rollback_supported=false,verified_at=null,
      config=(config-'verificationJobId'-'verificationError'-'verificationFailedAt') ||
             jsonb_build_object('onboarding','pending_runtime_verification'),
      updated_at=now()
  where project_id=v_id;

  perform nxc_private.project_runtime_verification_tick();
  return jsonb_build_object('ok',true,'projectId',v_id);
end
$function$;

-- Lock admin RPCs to service_role.
revoke all on function public.nxc_admin_create_host_setup_token(integer) from public,anon,authenticated;
grant execute on function public.nxc_admin_create_host_setup_token(integer) to service_role;
revoke all on function public.nxc_admin_create_project(jsonb) from public,anon,authenticated;
grant execute on function public.nxc_admin_create_project(jsonb) to service_role;
revoke all on function public.nxc_admin_queue_deployment(text,text,text) from public,anon,authenticated;
grant execute on function public.nxc_admin_queue_deployment(text,text,text) to service_role;
revoke all on function public.nxc_admin_retry_project_verification(text) from public,anon,authenticated;
grant execute on function public.nxc_admin_retry_project_verification(text) to service_role;
revoke all on function public.nxc_admin_deployment_tick() from public,anon,authenticated;
grant execute on function public.nxc_admin_deployment_tick() to service_role;

-- FK indexes recommended by the Supabase advisor.
create index if not exists nxc_alerts_node_id_idx on public.nxc_alerts(node_id);
create index if not exists nxc_alerts_project_id_idx on public.nxc_alerts(project_id);
create index if not exists nxc_deploy_plans_environment_id_idx on public.nxc_deploy_plans(environment_id);
create index if not exists nxc_deploy_plans_executed_deployment_id_idx on public.nxc_deploy_plans(executed_deployment_id);
create index if not exists nxc_repo_watches_github_connection_id_idx on public.nxc_repo_watches(github_connection_id);

-- Idempotent cron registration.
do $cron$
begin
  if not exists(select 1 from cron.job where jobname='nexcontrol-host-onboarding-v1') then
    perform cron.schedule('nexcontrol-host-onboarding-v1','* * * * *','select nxc_private.host_onboarding_tick();');
  end if;
  if not exists(select 1 from cron.job where jobname='nexcontrol-project-verify-v1') then
    perform cron.schedule('nexcontrol-project-verify-v1','* * * * *','select nxc_private.project_runtime_verification_tick();');
  end if;
  if not exists(select 1 from cron.job where jobname='nexcontrol-deployment-executor-v1') then
    perform cron.schedule('nexcontrol-deployment-executor-v1','* * * * *','select nxc_private.deployment_tick();');
  end if;
end
$cron$;
