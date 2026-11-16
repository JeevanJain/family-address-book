-- Session invalidation and per-hash PBKDF2 iteration count.
-- sessions_valid_after: Unix epoch seconds. Session cookies issued before this
-- moment are rejected. Bumped on disable, reset-password and password change.
ALTER TABLE users ADD COLUMN sessions_valid_after INTEGER NOT NULL DEFAULT 0;
-- password_iterations: PBKDF2 iteration count the stored hash was made with
-- (10000: low on purpose to fit the Cloudflare free plan's per-request CPU limit).
ALTER TABLE users ADD COLUMN password_iterations INTEGER NOT NULL DEFAULT 10000;
