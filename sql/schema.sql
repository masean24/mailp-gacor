-- Hubify Mail Database Schema
-- Run this file to initialize the database

-- Drop tables if exist (for fresh install)
DROP TABLE IF EXISTS emails CASCADE;
DROP TABLE IF EXISTS inboxes CASCADE;
DROP TABLE IF EXISTS domains CASCADE;
DROP TABLE IF EXISTS admin_users CASCADE;
DROP TABLE IF EXISTS names CASCADE;

-- Domains table
CREATE TABLE domains (
  id SERIAL PRIMARY KEY,
  domain VARCHAR(255) UNIQUE NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Names table (for human-like email generation)
CREATE TABLE names (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  gender VARCHAR(10) DEFAULT 'neutral', -- male, female, neutral
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Inboxes table
CREATE TABLE inboxes (
  id SERIAL PRIMARY KEY,
  local_part VARCHAR(255) NOT NULL,
  domain_id INTEGER REFERENCES domains(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT (NOW() + INTERVAL '24 hours'),
  UNIQUE(local_part, domain_id)
);

-- Emails table
CREATE TABLE emails (
  id SERIAL PRIMARY KEY,
  inbox_id INTEGER REFERENCES inboxes(id) ON DELETE CASCADE,
  from_address VARCHAR(255),
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  otp_code VARCHAR(16),
  has_attachment BOOLEAN DEFAULT false,
  received_at TIMESTAMP DEFAULT NOW()
);

-- Admin users table
CREATE TABLE admin_users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for better performance
CREATE INDEX idx_inboxes_expires ON inboxes(expires_at);
CREATE INDEX idx_inboxes_local_domain ON inboxes(local_part, domain_id);
CREATE INDEX idx_emails_inbox ON emails(inbox_id);
CREATE INDEX idx_emails_received ON emails(received_at);
CREATE INDEX idx_emails_inbox_received ON emails(inbox_id, received_at DESC);
CREATE INDEX idx_emails_inbox_otp ON emails(inbox_id, received_at DESC) WHERE otp_code IS NOT NULL;
CREATE INDEX idx_domains_active ON domains(is_active);
CREATE INDEX idx_names_active ON names(is_active);

-- Insert sample names (Indonesian names)
INSERT INTO names (name, gender) VALUES 
  ('budi', 'male'),
  ('andi', 'male'),
  ('agus', 'male'),
  ('deni', 'male'),
  ('eko', 'male'),
  ('fajar', 'male'),
  ('gilang', 'male'),
  ('hendra', 'male'),
  ('irwan', 'male'),
  ('joko', 'male'),
  ('dewi', 'female'),
  ('sari', 'female'),
  ('putri', 'female'),
  ('maya', 'female'),
  ('rina', 'female'),
  ('wati', 'female'),
  ('yuni', 'female'),
  ('ani', 'female'),
  ('sri', 'female'),
  ('lina', 'female'),
  ('alex', 'neutral'),
  ('rian', 'neutral'),
  ('dika', 'neutral'),
  ('yoga', 'neutral'),
  ('tara', 'neutral');

-- Display success message
SELECT 'Database schema created successfully!' as message;
