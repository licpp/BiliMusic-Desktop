-- Metadata is local and namespaced by target; no cloud protocol switch occurs here.
CREATE TABLE IF NOT EXISTS sync_devices(target TEXT NOT NULL,writer TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(target,writer));
CREATE TABLE IF NOT EXISTS sync_device_meta(target TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(target,key));
CREATE TABLE IF NOT EXISTS sync_v2_documents(target TEXT NOT NULL,domain TEXT NOT NULL,actor TEXT NOT NULL,confirmed TEXT NOT NULL,allocated INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(target,domain));
CREATE TABLE IF NOT EXISTS sync_v2_outbox(target TEXT NOT NULL,domain TEXT NOT NULL,actor TEXT NOT NULL,seq INTEGER NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(target,domain,actor,seq));
CREATE TABLE IF NOT EXISTS sync_v2_publications(target TEXT NOT NULL,actor TEXT NOT NULL,generation INTEGER NOT NULL,committed_head TEXT,pending TEXT,PRIMARY KEY(target,actor));
CREATE TABLE IF NOT EXISTS sync_v2_manifests(target TEXT NOT NULL,actor TEXT NOT NULL,domain TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(target,actor,domain));
