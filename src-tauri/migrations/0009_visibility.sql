-- Personal content filters are independent of source caches and library membership.
CREATE TABLE IF NOT EXISTS content_visibility(scope TEXT NOT NULL,target TEXT NOT NULL,register TEXT NOT NULL,PRIMARY KEY(scope,target));
CREATE TABLE IF NOT EXISTS visibility_runtime(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS visibility_heads(target TEXT NOT NULL,actor TEXT NOT NULL,generation INTEGER NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(target,actor));
CREATE TABLE IF NOT EXISTS visibility_publications(target TEXT PRIMARY KEY,pending TEXT,committed TEXT);
