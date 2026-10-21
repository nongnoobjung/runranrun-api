-- One saved profile per person (ID card / passport) in an account, so saving the same runner again updates it.
CREATE UNIQUE INDEX uq_runner_profiles_owner_doc ON runner_profiles(owner_user_id, id_doc_hash) WHERE deleted_at IS NULL;
