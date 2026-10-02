-- Thumbs-downs from Rachel and Brittney's Oct 2, 2026 test session, rewritten
-- as rules the agent can apply. Each row is matched on id AND its original
-- text, so this is a no-op on any database that does not hold those rows.

UPDATE agent_feedback
   SET training_instruction = 'Paycom is IPS''s full employee master, not only timekeeping. Rosters, departments, managers, titles and headcount come from paycom.employees (headcount = employee_status ''A''). Never substitute field crews or a count of time punches.',
       approval_status = 'approved', approved_by = 1
 WHERE id = 1 AND approval_status = 'pending' AND feedback_text LIKE 'We should have more info available in paycom%';

UPDATE agent_feedback
   SET training_instruction = 'Paycom history starts July 2020. Oct 2025 is only where the billing platform''s copy of Paycom time data begins: say that, and never call it Paycom''s earliest date.',
       approval_status = 'approved', approved_by = 1
 WHERE id = 2 AND approval_status = 'pending' AND feedback_text LIKE 'should go back to July 2020%';

UPDATE agent_feedback
   SET training_instruction = 'Profit for a profit center = revenue accounts (4xxxxx) minus expense accounts (5xxxxx-8xxxxx) for that division and location, closing entries excluded. Never all credits minus all debits. 100HOB = division 100 + location HOB.',
       approval_status = 'approved', approved_by = 1
 WHERE id = 3 AND approval_status = 'pending' AND feedback_text LIKE 'Revenue is way off%';

-- "We will need to fix that and get you access" (B1 bid attachments) is a
-- connector to build, not an answer rule.
UPDATE agent_feedback
   SET approval_status = 'rejected'
 WHERE id = 4 AND approval_status = 'pending' AND feedback_text LIKE 'we will need to fix that%';
