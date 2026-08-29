UPDATE tasks
SET creator_id = 'claude-agent', creator_name = 'Claude Agent'
WHERE creator_type = 'agent' AND creator_id = 'codex-agent';

UPDATE tasks
SET assignee_id = 'claude-agent', assignee_name = 'Claude Agent'
WHERE assignee_type = 'agent' AND assignee_id = 'codex-agent';

UPDATE comments
SET author_id = 'claude-agent', author_name = 'Claude Agent'
WHERE author_type = 'agent' AND author_id = 'codex-agent';
