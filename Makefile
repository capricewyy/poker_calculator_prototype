# Poker Night — local dev shortcuts (Supabase CLI).
# Requires Docker running + `supabase` CLI. See supabase/config.toml.
.PHONY: help start stop status db-reset db-test gen-types

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

start: ## Boot the local Supabase stack (Postgres, GoTrue, Studio)
	supabase start

stop: ## Stop the local Supabase stack
	supabase stop

status: ## Print local stack URLs + keys
	supabase status

db-reset: ## Drop + recreate local DB: re-apply all migrations, then seed.sql
	supabase db reset

db-test: ## Run the pgTAP suite under supabase/tests/
	supabase test db

gen-types: ## Generate TypeScript types from the local schema
	@mkdir -p supabase/types
	supabase gen types typescript --local > supabase/types/database.types.ts
	@echo "Wrote supabase/types/database.types.ts"
