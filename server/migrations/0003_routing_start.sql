-- ROUTING_DSL `start` rule list (start-point choice for maps with several start points).
ALTER TABLE routing_maps ADD COLUMN start TEXT;
