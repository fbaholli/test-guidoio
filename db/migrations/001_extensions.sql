create extension if not exists pgcrypto;
create extension if not exists btree_gist;   -- needed for uuid "=" inside a GiST exclusion constraint
