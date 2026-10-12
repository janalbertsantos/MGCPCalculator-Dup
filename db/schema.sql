-- MGC Pricing — Supabase schema.
-- Run once in the Supabase SQL editor (Dashboard → SQL editor → New query → paste → Run).
--
-- Every collection of the app's state is one table: id + the record as jsonb. That keeps the
-- app code unchanged and the data still queryable (select data->>'name' from accounts ...).
--
-- STAGE 1 (this file): the browser uses the public anon key and policies allow it to read and write.
-- That is only acceptable for the demo data in this repo. Before any real MGC data goes in,
-- switch to Supabase Auth and replace the "stage 1" policies (see the bottom of this file).

create table if not exists settings (key text primary key, data jsonb not null, updated_at timestamptz not null default now());

do $$
declare t text;
begin
  foreach t in array array[
    'skus', 'channels', 'cost_basis', 'margin_rules', 'buffers', 'accounts', 'competitor_readings',
    'publications', 'proposals', 'quotes', 'price_requests', 'acknowledgments', 'pl_email_log', 'users', 'events'
  ] loop
    execute format('create table if not exists %I (id text primary key, data jsonb not null, updated_at timestamptz not null default now())', t);
  end loop;
end $$;

create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'settings', 'skus', 'channels', 'cost_basis', 'margin_rules', 'buffers', 'accounts', 'competitor_readings',
    'publications', 'proposals', 'quotes', 'price_requests', 'acknowledgments', 'pl_email_log', 'users', 'events'
  ] loop
    execute format('drop trigger if exists %I_touch on %I', t, t);
    execute format('create trigger %I_touch before update on %I for each row execute function touch_updated_at()', t, t);
    execute format('alter table %I enable row level security', t);
    -- STAGE 1 policies: open to the anon key (demo data only).
    execute format('drop policy if exists stage1_read on %I', t);
    execute format('create policy stage1_read on %I for select to anon using (true)', t);
    execute format('drop policy if exists stage1_insert on %I', t);
    execute format('create policy stage1_insert on %I for insert to anon with check (true)', t);
    if t <> 'events' then
      execute format('drop policy if exists stage1_update on %I', t);
      execute format('create policy stage1_update on %I for update to anon using (true) with check (true)', t);
      execute format('drop policy if exists stage1_delete on %I', t);
      execute format('create policy stage1_delete on %I for delete to anon using (true)', t);
    end if;
    -- Live updates to other open browsers.
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- The event log is append-only: no update or delete policy exists for it, so those are refused.

-- STAGE 2 (before real data): enable Supabase Auth, give each row of `users` an auth id, then replace
-- the stage1_* policies with role checks, for example:
--   create policy mgr_write on publications for insert to authenticated
--     with check ((select data->>'role' from users where id = auth.uid()::text) in ('manager','admin'));
