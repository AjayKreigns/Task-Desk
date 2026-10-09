-- Migration: Add support for additional tasks and carry forward tracking
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_additional BOOLEAN DEFAULT FALSE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS carry_forward_from UUID REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS carry_forward_to UUID REFERENCES tasks(id) ON DELETE SET NULL;

-- Migration: Add support for time tracking
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS targeted_time NUMERIC DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS time_taken NUMERIC DEFAULT 0;
