-- Workers removed from the dashboard. Nothing is deleted: a worker is listed again as soon as
-- it is seen after it was hidden. Workers without shares for 7 days are hidden automatically
-- by the API's queries, not by this column.
ALTER TABLE workers ADD COLUMN hidden_at TIMESTAMPTZ;
