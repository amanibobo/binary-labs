-- Imported files: a folder's files copied into our object store at <lab_id>/files/<sha256>
-- and kept at their own folder paths, as an operator tool does it (bl demo-lab). An upload's
-- path is /Uploads/<experiment>/<name> and its external_id is its sha256, so it can't hold a
-- lab folder's tree; an import location's external_id is its path in that folder and its
-- source_rev is its sha256, as an instrument file's are. The worker reads it from the store,
-- and /api/files opens it like an upload.
alter type source_kind add value if not exists 'import';
