-- Paycom employee master, work profile only. Pay, home address, phone, birth
-- date, emergency contacts, benefits and EEO fields are deliberately absent:
-- managers see only their own people's pay in Paycom, and this agent has no
-- per-manager scoping yet.

CREATE SCHEMA IF NOT EXISTS paycom;

CREATE TABLE IF NOT EXISTS paycom.employees (
  eecode                    TEXT PRIMARY KEY,         -- Paycom employee code
  employee_name             TEXT,                     -- "Last, First"
  first_name                TEXT,
  last_name                 TEXT,
  preferred_first_name      TEXT,
  employee_status           TEXT,                     -- A = Active (headcount), T = Terminated; other codes unconfirmed
  department_code           TEXT,                     -- division: 100 Electrical, 200 Powerline, 800 Automation & Fiber, ...
  department_description    TEXT,
  location                  TEXT,                     -- "Hobbs Office", "Midland Office", ...
  cat1                      TEXT,
  cat1_desc                 TEXT,
  cat2                      TEXT,
  cat2_desc                 TEXT,
  business_title            TEXT,
  position_title            TEXT,                     -- e.g. Lineman Journeyman, Electrical Apprentice
  position_family_name      TEXT,
  supervisor_primary        TEXT,                     -- manager's name
  supervisor_primary_code   TEXT,
  fulltime_or_parttime      TEXT,
  hourly_or_salary          TEXT,
  hire_date                 DATE,
  rehire_date               DATE,
  termination_date          DATE,
  previous_termination_date DATE,
  termination_type          TEXT,
  last_position_change_date DATE,
  company_establishment_id  TEXT,
  company_location_id       TEXT,
  synced_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paycom_emp_status ON paycom.employees(employee_status);
CREATE INDEX IF NOT EXISTS idx_paycom_emp_dept   ON paycom.employees(department_code);
