-- =====================================================================
-- Legnano Chapter - Area riservata (demo su Supabase)
-- Incollare tutto in: Supabase > SQL Editor > New query > Run
-- Lo script si puo' rieseguire senza problemi.
-- =====================================================================

-- 1) Tabella unica "a documenti": replica la struttura dell'app
--    (events, iscrizioni, presenze, members, directory, pacchetti, news, config)
create table if not exists public.docs (
  collection  text        not null,
  id          text        not null,
  data        jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (collection, id)
);
alter table public.docs enable row level security;
alter table public.docs replica identity full;

-- 2) Amministratori (profilo "Admin" dell'app): si gestiscono solo da qui
create table if not exists public.app_owners (
  email text primary key
);
alter table public.app_owners enable row level security;   -- nessuna policy: invisibile dall'app

-- 3) Funzioni di ruolo
create or replace function public.app_is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_owners where lower(email) = lower(auth.jwt() ->> 'email'));
$$;

create or replace function public.app_role()
returns text language sql stable security definer set search_path = public as $$
  select case
    when app_is_owner() then 'admin'
    else coalesce(
      (select case when r = 'admin' then 'primary' else r end
         from (select data -> 'roles' ->> auth.uid()::text as r
                 from docs where collection = 'config' and id = 'roles') x),
      'rider')
  end;
$$;

-- 4) Aggiornamento parziale di un documento (equivalente di .update())
create or replace function public.doc_update(p_collection text, p_id text, p_patch jsonb)
returns void language plpgsql security invoker set search_path = public as $$
begin
  update docs set data = data || p_patch, updated_at = now()
   where collection = p_collection and id = p_id;
  if not found then
    raise exception 'documento non trovato o non autorizzato' using errcode = 'P0002';
  end if;
end;
$$;

-- 5) Regole di accesso (RLS)
--    - schede soci (members): le vede solo il socio stesso e gli officer
--    - rubrica, iscrizioni: ognuno scrive la propria, admin/primary tutte
--    - eventi, presenze, pacchetti, bacheca: scrivono admin, primary, activities
--    - profili (config): solo admin
drop policy if exists docs_select on public.docs;
drop policy if exists docs_insert on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs;

create policy docs_select on public.docs for select to authenticated using (
  collection <> 'members' or id = auth.uid()::text or app_role() <> 'rider'
);

create policy docs_insert on public.docs for insert to authenticated with check (
  case
    when collection in ('members','directory','iscrizioni')
      then id = auth.uid()::text or app_role() in ('admin','primary')
    when collection in ('events','presenze','pacchetti','news')
      then app_role() in ('admin','primary','activities')
    when collection = 'config'
      then app_role() = 'admin'
    else false
  end
);

create policy docs_update on public.docs for update to authenticated
using (
  case
    when collection in ('members','directory','iscrizioni')
      then id = auth.uid()::text or app_role() in ('admin','primary')
    when collection in ('events','presenze','pacchetti','news')
      then app_role() in ('admin','primary','activities')
    when collection = 'config'
      then app_role() = 'admin'
    else false
  end
)
with check (
  case
    when collection in ('members','directory','iscrizioni')
      then id = auth.uid()::text or app_role() in ('admin','primary')
    when collection in ('events','presenze','pacchetti','news')
      then app_role() in ('admin','primary','activities')
    when collection = 'config'
      then app_role() = 'admin'
    else false
  end
);

create policy docs_delete on public.docs for delete to authenticated using (
  case
    when collection in ('members','directory','iscrizioni')
      then id = auth.uid()::text or app_role() in ('admin','primary')
    when collection in ('events','presenze','pacchetti','news')
      then app_role() in ('admin','primary','activities')
    when collection = 'config'
      then app_role() = 'admin'
    else false
  end
);

-- 6) Permessi e aggiornamento in tempo reale
revoke all on public.docs from anon;
grant select, insert, update, delete on public.docs to authenticated;
grant execute on function public.app_is_owner(), public.app_role(),
                          public.doc_update(text, text, jsonb) to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null;
end $$;

-- 7) >>> METTI QUI LA TUA EMAIL (quella con cui entrerai nell'app come Admin) <<<
insert into public.app_owners (email) values ('LA-TUA-EMAIL@esempio.it')
on conflict do nothing;
