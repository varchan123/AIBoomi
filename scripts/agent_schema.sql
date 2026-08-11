create table if not exists agent_runs (
  run_id text primary key,
  approval_nonce_hash text not null unique,
  action_hash text not null,
  status text not null check (status in ('executing', 'completed', 'failed', 'send_outcome_unknown')),
  incident_id text references incidents(incident_id),
  work_order_id text references maintenance_actions(work_order_id),
  contact_id text not null,
  approved_sender text not null,
  proposal_json jsonb not null,
  error_message text,
  approved_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists agent_actions (
  action_id bigint generated always as identity primary key,
  run_id text not null references agent_runs(run_id),
  action_index int,
  incident_id text references incidents(incident_id),
  work_order_id text references maintenance_actions(work_order_id),
  action_type text not null,
  tool_name text not null,
  input_json jsonb,
  output_json jsonb,
  status text not null,
  external_message_sid text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, action_index)
);

create unique index if not exists agent_actions_external_sid_idx
  on agent_actions(external_message_sid)
  where external_message_sid is not null;

create table if not exists external_conversations (
  conversation_id bigint generated always as identity primary key,
  run_id text not null references agent_runs(run_id),
  channel text not null check (channel = 'whatsapp'),
  external_user text not null,
  contact_id text not null,
  incident_id text not null references incidents(incident_id),
  work_order_id text not null references maintenance_actions(work_order_id),
  latest_external_message_sid text,
  status text not null default 'pending_send' check (status in ('pending_send', 'active', 'closed')),
  bounded_status_updates boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, work_order_id)
);

create unique index if not exists external_conversations_one_active_sender_idx
  on external_conversations(channel, external_user)
  where status in ('pending_send', 'active');

alter table maintenance_actions
  add column if not exists technician_update text,
  add column if not exists technician_root_cause_claim text,
  add column if not exists technician_fix_claim text,
  add column if not exists technician_claims_need_review boolean not null default false,
  add column if not exists last_external_update_at timestamptz;

create index if not exists agent_actions_work_order_idx on agent_actions(work_order_id, created_at desc);
create index if not exists external_conversations_sender_idx on external_conversations(channel, external_user, status);

create table if not exists inbound_messages (
  message_sid text primary key,
  sender text not null,
  conversation_id bigint references external_conversations(conversation_id),
  incident_id text references incidents(incident_id),
  work_order_id text references maintenance_actions(work_order_id),
  body text,
  voice_transcript text,
  media_type text,
  classification_json jsonb,
  processing_status text not null check (processing_status in ('processing', 'applied', 'applied_claims_review', 'staged', 'failed')),
  review_reason text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists inbound_messages_review_idx
  on inbound_messages(processing_status, received_at desc);

create or replace function apply_bounded_work_order_reply(
  p_message_sid text,
  p_sender text,
  p_work_order_id text,
  p_status text,
  p_technician_update text default null,
  p_root_cause_claim text default null,
  p_fix_claim text default null,
  p_classification jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  convo external_conversations%rowtype;
  new_processing_status text;
begin
  if p_status not in ('Accepted', 'In Progress', 'Needs Help', 'Resolved - Awaiting Verification') then
    raise exception 'Inbound status is not automatically permitted';
  end if;

  select * into convo
  from external_conversations
  where channel = 'whatsapp'
    and external_user = p_sender
    and work_order_id = p_work_order_id
    and status = 'active'
    and bounded_status_updates = true
  for update;

  if not found then
    raise exception 'No active approved conversation for sender and work order';
  end if;

  if not exists (
    select 1 from inbound_messages
    where message_sid = p_message_sid
      and sender = p_sender
      and work_order_id = p_work_order_id
      and processing_status = 'processing'
  ) then
    raise exception 'Inbound message is not eligible for application';
  end if;

  update maintenance_actions
  set status = p_status,
      technician_update = nullif(p_technician_update, ''),
      technician_root_cause_claim = coalesce(nullif(p_root_cause_claim, ''), technician_root_cause_claim),
      technician_fix_claim = coalesce(nullif(p_fix_claim, ''), technician_fix_claim),
      technician_claims_need_review = technician_claims_need_review
        or nullif(p_root_cause_claim, '') is not null
        or nullif(p_fix_claim, '') is not null,
      last_external_update_at = now()
  where work_order_id = p_work_order_id
    and incident_id = convo.incident_id;

  if not found then
    raise exception 'Mapped work order was not found';
  end if;

  new_processing_status := case
    when nullif(p_root_cause_claim, '') is not null or nullif(p_fix_claim, '') is not null
      then 'applied_claims_review'
    else 'applied'
  end;

  update inbound_messages
  set classification_json = p_classification,
      processing_status = new_processing_status,
      processed_at = now()
  where message_sid = p_message_sid;

  update external_conversations
  set latest_external_message_sid = p_message_sid,
      updated_at = now()
  where conversation_id = convo.conversation_id;

  insert into agent_actions (
    run_id, action_index, incident_id, work_order_id, action_type, tool_name,
    input_json, output_json, status, external_message_sid
  ) values (
    convo.run_id, null, convo.incident_id, convo.work_order_id,
    'update_work_order_from_reply', 'update_work_order_from_reply',
    jsonb_build_object('message_sid', p_message_sid, 'sender', p_sender),
    jsonb_build_object('status', p_status, 'technician_update', p_technician_update,
      'claims_require_review', new_processing_status = 'applied_claims_review'),
    'completed', p_message_sid
  );

  return jsonb_build_object(
    'incident_id', convo.incident_id,
    'work_order_id', convo.work_order_id,
    'status', p_status,
    'claims_require_review', new_processing_status = 'applied_claims_review'
  );
end;
$$;

revoke all on table agent_runs, agent_actions, external_conversations, inbound_messages from anon, authenticated;
revoke all on function apply_bounded_work_order_reply(text, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function apply_bounded_work_order_reply(text, text, text, text, text, text, text, jsonb) to service_role;
