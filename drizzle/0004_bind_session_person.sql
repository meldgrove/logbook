ALTER TABLE "auth_session" ADD COLUMN "oidc_person_id" uuid;--> statement-breakpoint
-- Preserve active sessions when the new image starts.
UPDATE "auth_session" AS session
SET "oidc_person_id" = person."id"
FROM "person" AS person
WHERE person."oidc_subject" = session."oidc_subject" AND person."has_access";--> statement-breakpoint
CREATE FUNCTION bind_session_person() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bound_person uuid;
BEGIN
  -- Hold the person row until the insert commits. Directory sync takes a
  -- conflicting row lock before revoking sessions for a changed subject.
  SELECT "id" INTO bound_person
  FROM "person"
  WHERE "oidc_subject" = NEW."oidc_subject"
    AND "has_access"
    AND (NEW."oidc_person_id" IS NULL OR "id" = NEW."oidc_person_id")
  FOR SHARE;

  IF NEW."oidc_person_id" IS NOT NULL AND bound_person IS NULL THEN
    RAISE EXCEPTION 'The OIDC subject no longer belongs to the admitted person' USING ERRCODE = '23514';
  END IF;

  -- An older web image can still write sessions during an upgrade or rollback.
  NEW."oidc_person_id" := bound_person;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER bind_session_person BEFORE INSERT ON "auth_session"
FOR EACH ROW EXECUTE FUNCTION bind_session_person();
