-- Weave schema.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_.-]{3,32}$'),
  display_name  text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 64),
  password_hash text NOT NULL,
  color         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  main_file  text NOT NULL DEFAULT 'main.tex',
  template   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user ON project_members(user_id);

CREATE TABLE invites (
  token      text PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('editor', 'viewer')),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked    boolean NOT NULL DEFAULT false
);

CREATE TABLE files (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path       text NOT NULL CHECK (length(path) BETWEEN 1 AND 200),
  kind       text NOT NULL CHECK (kind IN ('text', 'binary')),
  mime       text,
  data       bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, path)
);

-- Append-only CRDT op log since the latest snapshot of each text file.
CREATE TABLE doc_ops (
  file_id    uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  agent      text NOT NULL,
  seq        integer NOT NULL,
  op         jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, agent, seq)
);

-- Latest compacted CRDT state per text file.
CREATE TABLE doc_snapshots (
  file_id    uuid PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  vv         jsonb NOT NULL,
  state      jsonb NOT NULL,
  text       text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Named versions of a whole project (history).
CREATE TABLE versions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  auto       boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX versions_project ON versions(project_id, created_at DESC);

CREATE TABLE version_files (
  version_id uuid NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  path       text NOT NULL,
  text       text NOT NULL,
  PRIMARY KEY (version_id, path)
);
