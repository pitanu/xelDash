-- Live dashboard updates. Every service event is announced on the `xeldash_live` channel;
-- the API relays these notifications to dashboards over WebSocket. The payload carries only
-- the id and type (NOTIFY payloads are limited to 8000 bytes); clients refetch the details.

CREATE FUNCTION notify_service_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'xeldash_live',
    json_build_object('type', 'event', 'id', NEW.id::text, 'eventType', NEW.type)::text
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER service_events_notify
  AFTER INSERT ON service_events
  FOR EACH ROW EXECUTE FUNCTION notify_service_event();
