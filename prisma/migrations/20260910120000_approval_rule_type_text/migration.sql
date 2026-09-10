-- Allow free-text approval rule types (was RequestType enum)
ALTER TABLE "ApprovalRule"
  ALTER COLUMN "requestType" TYPE TEXT
  USING ("requestType"::text);
