CREATE TABLE IF NOT EXISTS crdt_operations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('insert', 'delete')),
  previous_id TEXT,
  target_id TEXT,
  value TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crdt_operations_created_at_idx
  ON crdt_operations (created_at, id);
