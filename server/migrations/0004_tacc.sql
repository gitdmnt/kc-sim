-- kcSHIPDATA TACC is the innate torpedo accuracy: store it as stat `tacc`. `acc` (general hidden
-- accuracy) is produced only by the estimator (`estimator:*` sources).
UPDATE estimates SET stat = 'tacc'
WHERE stat = 'acc' AND source_id IN (SELECT id FROM sources WHERE key NOT LIKE 'estimator%');
