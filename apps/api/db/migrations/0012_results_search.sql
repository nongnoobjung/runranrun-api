-- Searching for a runner across events looks results up by bib alone; the unique (race_id, bib_number) key cannot serve that.
CREATE INDEX idx_results_bib_published ON results(bib_number) WHERE is_published;
