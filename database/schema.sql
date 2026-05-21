CREATE TABLE IF NOT EXISTS crdt_operations (
  document_id TEXT NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('insert', 'delete')),
  actor_id TEXT,
  previous_id TEXT,
  target_id TEXT,
  value TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, id)
);

CREATE INDEX IF NOT EXISTS crdt_operations_created_at_idx
  ON crdt_operations (document_id, created_at, id);

CREATE INDEX IF NOT EXISTS crdt_operations_previous_idx
  ON crdt_operations (document_id, previous_id);

CREATE INDEX IF NOT EXISTS crdt_operations_target_idx
  ON crdt_operations (document_id, target_id);

CREATE TABLE IF NOT EXISTS crdt_snapshots (
  document_id TEXT PRIMARY KEY,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
