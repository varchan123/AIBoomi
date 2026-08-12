create table if not exists work_order_closure_audit (
  id bigint generated always as identity primary key,
  work_order_id text not null unique references maintenance_actions(work_order_id),
  incident_id text not null references incidents(incident_id),
  closure_note text not null check (char_length(btrim(closure_note)) between 3 and 1000),
  previous_work_order_status text,
  closed_by text not null,
  closed_at timestamptz not null default now()
);

create index if not exists work_order_closure_audit_incident_idx
  on work_order_closure_audit(incident_id, closed_at desc);

create or replace function close_agent_work_order(
  p_work_order_id text,
  p_closure_note text,
  p_contact_id text,
  p_external_user text,
  p_closed_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  work_order maintenance_actions%rowtype;
  conversation external_conversations%rowtype;
  audit work_order_closure_audit%rowtype;
  closed_conversation_count integer;
begin
  if nullif(btrim(p_closure_note), '') is null or char_length(btrim(p_closure_note)) not between 3 and 1000 then
    raise exception using errcode = '22023', message = 'INVALID_CLOSURE_NOTE';
  end if;

  select * into work_order
  from maintenance_actions
  where work_order_id = p_work_order_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'WORK_ORDER_NOT_FOUND';
  end if;

  select * into conversation
  from external_conversations
  where work_order_id = p_work_order_id
    and incident_id = work_order.incident_id
    and contact_id = p_contact_id
    and external_user = p_external_user
    and channel = 'whatsapp'
  order by conversation_id desc
  limit 1
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'WORK_ORDER_CONVERSATION_CONFLICT';
  end if;

  if work_order.status = 'Closed - Human Verified' then
    select * into audit
    from work_order_closure_audit
    where work_order_id = p_work_order_id;

    if not found then
      raise exception using errcode = 'P0001', message = 'CLOSED_WORK_ORDER_MISSING_AUDIT';
    end if;

    return jsonb_build_object(
      'work_order_id', work_order.work_order_id,
      'work_order_status', work_order.status,
      'incident_id', work_order.incident_id,
      'incident_status', (select status from incidents where incident_id = work_order.incident_id),
      'conversation_status', 'closed',
      'closure_note', audit.closure_note,
      'closed_at', audit.closed_at,
      'already_closed', true
    );
  end if;

  if conversation.status not in ('pending_send', 'active') then
    raise exception using errcode = 'P0001', message = 'CONVERSATION_NOT_ACTIVE';
  end if;

  update maintenance_actions
  set status = 'Closed - Human Verified',
      completion_time = coalesce(completion_time, now())
  where work_order_id = work_order.work_order_id
    and incident_id = work_order.incident_id;

  update external_conversations
  set status = 'closed', updated_at = now()
  where work_order_id = work_order.work_order_id
    and incident_id = work_order.incident_id
    and contact_id = p_contact_id
    and external_user = p_external_user
    and status in ('pending_send', 'active');
  get diagnostics closed_conversation_count = row_count;

  if closed_conversation_count < 1 then
    raise exception using errcode = 'P0001', message = 'CONVERSATION_CLOSE_CONFLICT';
  end if;

  update incidents
  set status = 'Resolved'
  where incident_id = work_order.incident_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'INCIDENT_NOT_FOUND';
  end if;

  insert into work_order_closure_audit (
    work_order_id, incident_id, closure_note, previous_work_order_status, closed_by
  ) values (
    work_order.work_order_id, work_order.incident_id, btrim(p_closure_note), work_order.status, p_closed_by
  )
  on conflict (work_order_id) do nothing
  returning * into audit;

  if not found then
    select * into strict audit from work_order_closure_audit where work_order_id = work_order.work_order_id;
  end if;

  insert into agent_actions (
    run_id, action_index, incident_id, work_order_id, action_type, tool_name,
    input_json, output_json, status
  ) values (
    conversation.run_id, null, work_order.incident_id, work_order.work_order_id,
    'human_verify_and_close', 'close_agent_work_order',
    jsonb_build_object('closure_audit_id', audit.id, 'closed_by', p_closed_by),
    jsonb_build_object('work_order_status', 'Closed - Human Verified',
      'incident_status', 'Resolved', 'conversation_status', 'closed'),
    'completed'
  );

  return jsonb_build_object(
    'work_order_id', work_order.work_order_id,
    'work_order_status', 'Closed - Human Verified',
    'incident_id', work_order.incident_id,
    'incident_status', 'Resolved',
    'conversation_status', 'closed',
    'closure_note', audit.closure_note,
    'closed_at', audit.closed_at,
    'already_closed', false
  );
end;
$$;

revoke all on table work_order_closure_audit from anon, authenticated;
revoke all on function close_agent_work_order(text, text, text, text, text) from public, anon, authenticated;
grant execute on function close_agent_work_order(text, text, text, text, text) to service_role;
