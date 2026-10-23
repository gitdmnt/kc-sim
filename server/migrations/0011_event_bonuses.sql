-- Event historical (特効) bonuses and armour debuffs per map: kancolle-replay js/data/bonus/{W-M}.json plus the
-- checked-in manual file server/data/event-bonuses.json (current events), flattened by src/eventBonus.ts.
CREATE TABLE event_bonuses (
  map_id INTEGER PRIMARY KEY,          -- world*10+no
  date TEXT,                           -- source file date
  note TEXT,
  bonuses TEXT NOT NULL,               -- JSON [{nodes, nodesExclude, dmg?, acc?, eva?, shipType?, shipBase?, shipClass?, shipId?, requireEquip*?, ...}]
  lbas_bonuses TEXT NOT NULL,          -- same shape, for land-based air squadrons
  debuffs TEXT NOT NULL,               -- JSON [{nodes, nodesExclude, shipId?, amount}]
  source_id INTEGER REFERENCES sources(id)
);
