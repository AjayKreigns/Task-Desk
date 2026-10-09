-- =============================================
-- Team Dashboard — Supabase Schema
-- Run this SQL in your Supabase SQL Editor
-- =============================================

-- 1. Employees Table
CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  designation TEXT NOT NULL DEFAULT '',
  email TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Websites Table
CREATE TABLE websites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Tasks Table
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  category TEXT DEFAULT 'General',
  assigned_to UUID REFERENCES employees(id) ON DELETE SET NULL,
  website_id UUID REFERENCES websites(id) ON DELETE SET NULL,
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  reference_url TEXT DEFAULT '',
  completion_url TEXT DEFAULT '',
  completed_date TIMESTAMPTZ,
  month INTEGER NOT NULL,
  year INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Enable Row Level Security (open for now — tighten with auth later)
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE websites ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

-- Allow all operations for now (public access via anon key)
CREATE POLICY "Allow all on employees" ON employees FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on websites" ON websites FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on tasks" ON tasks FOR ALL USING (true) WITH CHECK (true);

-- 5. Enable Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE employees;
ALTER PUBLICATION supabase_realtime ADD TABLE websites;
ALTER PUBLICATION supabase_realtime ADD TABLE tasks;

-- 6. Seed some default data
INSERT INTO employees (name, designation, email) VALUES
  ('Priya Sharma', 'SEO Specialist', 'priya@company.com'),
  ('Rahul Verma', 'Content Writer', 'rahul@company.com'),
  ('Anita Desai', 'Social Media Manager', 'anita@company.com');

INSERT INTO websites (name, description) VALUES
  ('techsolutions.com', 'Main Business Website'),
  ('digitalhub.in', 'Digital Marketing Blog');

-- =============================================
-- Migration: Add progress column for granular task status
-- Run this in Supabase SQL Editor if upgrading
-- =============================================
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN ('pending', 'completed'));
