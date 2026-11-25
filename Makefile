SHELL := /bin/bash
.PHONY: deps up down reset deploy seed migrate db-create test test-unit test-contracts invariants e2e send-deposit burst demo-catchup demo-catchup-sim demo-reorg demo-chaos

deps:            ## install JS deps + foundry libs
	pnpm install
	cd contracts && [ -d lib/forge-std ] || forge install foundry-rs/forge-std --no-git
	cd contracts && [ -d lib/openzeppelin-contracts ] || forge install OpenZeppelin/openzeppelin-contracts@v5.4.0 --no-git

up:              ## start the whole stack natively (postgres must be running)
	./scripts/stack.sh up

down:            ## stop everything (graceful)
	./scripts/stack.sh down

status:          ## service status
	./scripts/stack.sh status

kill-%:          ## SIGKILL a service, e.g. make kill-workflow
	./scripts/stack.sh kill $*

restart-%:       ## (re)start a service, e.g. make restart-workflow
	./scripts/stack.sh restart $*

logs-%:          ## follow a service log
	./scripts/stack.sh logs $*

deploy:          ## deploy mock tokens to $$CHAIN (Base Sepolia), writes deployments/<chainId>.json
	./scripts/deploy.sh

reset:           ## stop everything and wipe local state (DB, Restate journal, mock state). Keeps deployments/.
	./scripts/stack.sh down
	psql -h localhost -U postgres -c 'drop database if exists mopay' -c 'create database mopay'
	rm -rf data/restate data/indodax.sqlite* data/mobee.sqlite* data/bifast.sqlite* data/seed-clients.json data/logs data/pids

test-contracts:
	cd contracts && forge test

test: test-contracts   ## contracts + all unit/integration tests (needs local Postgres)
	pnpm test

lint:
	pnpm lint && pnpm typecheck

invariants:      ## check system invariants against the running stack
	npx tsx scripts/invariants.ts

send-deposit:    ## make send-deposit CLIENT=A AMOUNT=1000
	npx tsx scripts/send-deposit.ts --client $${CLIENT:-A} --amount $${AMOUNT:-100}

burst:           ## make burst COUNT=50
	npx tsx scripts/burst.ts --count $${COUNT:-20}

demo-catchup:    ## real chain: stop indexer, burst, stay down WAIT s, restart, watch catch-up
	./scripts/catchup-demo.sh

demo-catchup-sim: ## simulated chain: 50 deposits + 5000 blocks while down
	npx tsx scripts/catchup-sim.ts

demo-reorg:      ## simulated chain: reorged deposit -> orphaned, never paid
	npx tsx scripts/reorg-demo.ts

e2e:             ## chaos on + COUNT real deposits (default 100) → all complete → invariants
	./scripts/e2e.sh

demo-chaos:      ## storm chaos on both mocks + burst of real deposits
	./scripts/demo-chaos.sh

help:
	@grep -E '^[a-z%-]+:.*## ' Makefile | sed 's/:.*## /\t/' | expand -t 20

migrate:         ## apply DB migrations
	pnpm db:migrate

seed:            ## seed 2 demo clients (keys -> data/seed-clients.json)
	pnpm db:seed

db-create:       ## create local databases (native Postgres)
	psql -h localhost -U postgres -tc "select 1 from pg_database where datname='mopay'" | grep -q 1 || psql -h localhost -U postgres -c 'create database mopay'
	psql -h localhost -U postgres -tc "select 1 from pg_database where datname='mopay_test'" | grep -q 1 || psql -h localhost -U postgres -c 'create database mopay_test'

indodax:         ## run indodax-mock, TAPIv2 (port 4100)
	pnpm --filter @mopay/indodax-mock start

bifast:          ## run bifast-mock (port 4200)
	pnpm --filter @mopay/bifast-mock start

indexer:         ## run the indexer (port 4300: /healthz /readyz /metrics /status)
	pnpm --filter @mopay/indexer start

restate:         ## run restate-server natively (ingress 8080, admin 9070)
	mkdir -p data/restate && RESTATE_LOG_FILTER=warn node_modules/.bin/restate-server --listen-mode tcp --base-dir data/restate --node-name mopay

workflow:        ## run the offramp workflow endpoint (port 9080)
	pnpm --filter @mopay/workflow start

register:        ## register the workflow deployment with Restate
	pnpm --filter @mopay/workflow register

api:             ## run the Mopay API (port 4000, docs at /docs)
	pnpm --filter @mopay/api start
