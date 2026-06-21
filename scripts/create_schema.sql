create extension if not exists vector;

create table if not exists machines (
  machine_id text primary key,
  machine_name text not null,
  equipment_type text,
  area text,
  criticality text,
  tep_tags text,
  normal_operating_note text
);

create table if not exists employees (
  employee_id text primary key,
  name text not null,
  role text,
  shift text
);

create table if not exists spare_parts (
  part_id text primary key,
  part_name text not null,
  category text,
  stock_qty int,
  unit_cost_inr numeric
);

create table if not exists tep_fault_dictionary (
  tep_fault_number int primary key,
  tep_fault_name text not null,
  rca_category text,
  default_machine_id text references machines(machine_id)
);

create table if not exists tep_variable_map (
  tep_tag text primary key,
  csv_column_name text not null,
  description text,
  unit text,
  mapped_machine_id text references machines(machine_id),
  variable_type text
);

create table if not exists incidents (
  incident_id text primary key,
  start_time timestamptz not null,
  machine_id text not null references machines(machine_id),
  machine_name text,
  tep_fault_number int references tep_fault_dictionary(tep_fault_number),
  rca_category text,
  operator_description text not null,
  severity text,
  downtime_minutes int default 0,
  operator_id text references employees(employee_id),
  engineer_id text references employees(employee_id),
  status text not null,
  rca_id text null,
  created_at timestamptz default now()
);

create table if not exists rca_documents (
  rca_id text primary key,
  incident_id text references incidents(incident_id),
  machine_id text references machines(machine_id),
  machine_name text,
  tep_fault_number int references tep_fault_dictionary(tep_fault_number),
  rca_category text,
  problem_statement text,
  symptoms jsonb,
  suspected_root_cause text,
  confirmed_root_cause text,
  fix_applied text,
  preventive_action text,
  downtime_minutes int,
  handled_by_operator text,
  handled_by_engineer text,
  recurrence text,
  status text,
  rca_text text not null,
  created_at timestamptz default now()
);

do $$ begin
  alter table incidents add constraint incidents_rca_id_fkey
    foreign key (rca_id) references rca_documents(rca_id);
exception when duplicate_object then null;
end $$;

create table if not exists alarm_logs (
  alarm_id text primary key,
  incident_id text references incidents(incident_id),
  timestamp timestamptz not null,
  machine_id text references machines(machine_id),
  tep_tag text,
  alarm_type text,
  severity text,
  alarm_message text
);

create table if not exists sensor_snapshots (
  snapshot_id bigint generated always as identity primary key,
  incident_id text references incidents(incident_id),
  timestamp timestamptz not null,
  machine_id text references machines(machine_id),
  tep_tag text,
  phase text,
  synthetic_value numeric,
  z_score_vs_normal numeric,
  status text,
  unique (incident_id, timestamp, tep_tag, phase)
);

create table if not exists maintenance_actions (
  work_order_id text primary key,
  incident_id text references incidents(incident_id),
  machine_id text references machines(machine_id),
  maintenance_type text,
  action_taken text,
  part_used text,
  cost_inr numeric,
  owner_employee_id text references employees(employee_id),
  completion_time timestamptz,
  status text
);

create table if not exists sop_documents (
  sop_id text primary key,
  machine_id text references machines(machine_id),
  title text not null,
  content text not null,
  created_at timestamptz default now()
);

create table if not exists tep_fault_signatures (
  document_id text primary key,
  source_type text,
  tep_fault_number int references tep_fault_dictionary(tep_fault_number),
  tep_fault_name text,
  rca_category text,
  primary_machine_id text references machines(machine_id),
  affected_units jsonb,
  fault_start_sample int,
  baseline_window text,
  fault_window text,
  top_anomalies jsonb,
  likely_physical_interpretation text,
  linked_incident_ids jsonb,
  embedding_text text not null,
  created_at timestamptz default now()
);

create table if not exists tep_fault_summary (
  document_id text primary key,
  tep_fault_number int references tep_fault_dictionary(tep_fault_number),
  tep_fault_name text,
  rca_category text,
  primary_machine_id text references machines(machine_id),
  affected_units text,
  top_sensor_1 text,
  top_sensor_1_desc text,
  top_sensor_1_change_pct numeric,
  top_sensor_1_direction text,
  top_sensor_2 text,
  top_sensor_2_desc text,
  top_sensor_2_change_pct numeric,
  top_sensor_2_direction text,
  top_sensor_3 text,
  top_sensor_3_desc text,
  top_sensor_3_change_pct numeric,
  top_sensor_3_direction text,
  embedding_text text
);

create table if not exists documents (
  doc_id text primary key,
  embedding vector(1536),
  doc_type text not null,
  title text,
  text text not null,
  source_table text not null,
  source_id text not null,
  machine_id text references machines(machine_id),
  tep_fault_number int references tep_fault_dictionary(tep_fault_number),
  rca_category text,
  metadata jsonb,
  chunk_index int default 0,
  created_at timestamptz default now()
);

create index if not exists incidents_machine_time_idx on incidents(machine_id, start_time desc);
create index if not exists incidents_status_idx on incidents(status);
create index if not exists maintenance_machine_idx on maintenance_actions(machine_id, completion_time desc);
create index if not exists alarm_machine_idx on alarm_logs(machine_id, timestamp desc);
create index if not exists documents_machine_idx on documents(machine_id);
create index if not exists documents_type_idx on documents(doc_type);
create index if not exists documents_embedding_idx on documents using hnsw (embedding vector_cosine_ops);

create or replace function match_documents(
  query_embedding vector(1536),
  match_count int default 8,
  filter_machine_id text default null
)
returns table (
  doc_id text, doc_type text, title text, text text, source_id text,
  machine_id text, tep_fault_number int, rca_category text, metadata jsonb,
  similarity float
)
language sql stable
as $$
  select d.doc_id, d.doc_type, d.title, d.text, d.source_id, d.machine_id,
    d.tep_fault_number, d.rca_category, d.metadata,
    1 - (d.embedding <=> query_embedding) as similarity
  from documents d
  where filter_machine_id is null or d.machine_id = filter_machine_id
  order by d.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function dashboard_snapshot(period_days int default 30)
returns jsonb language sql stable as $$
with bounds as (
  select now() - make_interval(days => period_days) as current_start,
         now() - make_interval(days => period_days * 2) as previous_start
),
open_rows as (
  select i.*, m.area from incidents i join machines m using(machine_id)
  where lower(i.status) not in ('resolved','closed')
),
current_count as (
  select count(*)::int n from incidents, bounds where start_time >= current_start
),
previous_count as (
  select count(*)::int n from incidents, bounds
  where start_time >= previous_start and start_time < current_start
),
repeat_rows as (
  select machine_id, coalesce(rca_category, 'Unclassified') rca_category,
         count(*)::int incident_count, max(start_time) last_seen
  from incidents, bounds where start_time >= previous_start
  group by machine_id, coalesce(rca_category, 'Unclassified') having count(*) > 1
  order by incident_count desc
),
top_rows as (
  select i.machine_id, max(i.machine_name) machine_name, count(*)::int incident_count
  from incidents i group by i.machine_id order by incident_count desc limit 8
),
downtime_rows as (
  select i.machine_id, max(i.machine_name) machine_name,
         coalesce(sum(i.downtime_minutes),0)::int downtime_minutes
  from incidents i group by i.machine_id order by downtime_minutes desc limit 8
),
recent_rows as (
  select i.*, r.confirmed_root_cause, r.fix_applied, r.preventive_action
  from incidents i left join rca_documents r on r.rca_id = i.rca_id
  order by i.start_time desc limit 20
)
select jsonb_build_object(
  'open_incidents', coalesce((select jsonb_agg(to_jsonb(open_rows) order by start_time desc) from open_rows), '[]'::jsonb),
  'incident_count_current_period', (select n from current_count),
  'incident_count_previous_period', (select n from previous_count),
  'repeat_failures', coalesce((select jsonb_agg(to_jsonb(repeat_rows)) from repeat_rows), '[]'::jsonb),
  'top_problem_machines', coalesce((select jsonb_agg(to_jsonb(top_rows)) from top_rows), '[]'::jsonb),
  'downtime_by_machine', coalesce((select jsonb_agg(to_jsonb(downtime_rows)) from downtime_rows), '[]'::jsonb),
  'recent_incidents', coalesce((select jsonb_agg(to_jsonb(recent_rows)) from recent_rows), '[]'::jsonb)
);
$$;

create or replace function structured_qa(
  p_intent text,
  p_machine_id text default null,
  p_employee_name text default null,
  p_period_days int default 30,
  p_limit int default 10
)
returns jsonb language plpgsql stable as $$
declare result jsonb;
begin
  case p_intent
    when 'incident_count_by_machine' then
      select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into result from (
        select machine_id, max(machine_name) machine_name, count(*)::int incident_count
        from incidents where start_time >= now() - make_interval(days => p_period_days)
          and (p_machine_id is null or machine_id = p_machine_id)
        group by machine_id order by incident_count desc limit p_limit
      ) q;
    when 'open_incidents' then
      select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into result from (
        select * from incidents where lower(status) not in ('resolved','closed')
          and (p_machine_id is null or machine_id = p_machine_id)
        order by start_time desc limit p_limit
      ) q;
    when 'top_problem_machines' then
      select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into result from (
        select machine_id, max(machine_name) machine_name, count(*)::int incident_count
        from incidents where start_time >= now() - make_interval(days => p_period_days)
        group by machine_id order by incident_count desc limit p_limit
      ) q;
    when 'repeat_failures' then
      select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into result from (
        select machine_id, coalesce(rca_category, 'Unclassified') rca_category,
          count(*)::int incident_count, max(start_time) last_seen
        from incidents where start_time >= now() - make_interval(days => p_period_days)
        group by machine_id, coalesce(rca_category, 'Unclassified') having count(*) > 1
        order by incident_count desc limit p_limit
      ) q;
    when 'downtime_by_machine' then
      select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into result from (
        select machine_id, max(machine_name) machine_name,
          coalesce(sum(downtime_minutes), 0)::int downtime_minutes
        from incidents where start_time >= now() - make_interval(days => p_period_days)
        group by machine_id order by downtime_minutes desc limit p_limit
      ) q;
    when 'maintenance_cost_by_machine' then
      select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into result from (
        select machine_id, round(coalesce(sum(cost_inr), 0), 2) maintenance_cost_inr
        from maintenance_actions where completion_time >= now() - make_interval(days => p_period_days)
        group by machine_id order by maintenance_cost_inr desc limit p_limit
      ) q;
    when 'incidents_by_employee' then
      select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into result from (
        select i.incident_id, i.start_time, i.machine_id, i.machine_name, i.status,
          op.name operator_name, eng.name engineer_name
        from incidents i left join employees op on op.employee_id = i.operator_id
          left join employees eng on eng.employee_id = i.engineer_id
        where p_employee_name is null
          or op.name ilike '%' || p_employee_name || '%'
          or eng.name ilike '%' || p_employee_name || '%'
        order by i.start_time desc limit p_limit
      ) q;
    else
      raise exception 'Unsupported structured intent: %', p_intent;
  end case;
  return result;
end $$;
