SHELL := /bin/bash
.PHONY: deps up down reset deploy seed migrate db-create test test-contracts

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

test-contracts:
	cd contracts && forge test

test: test-contracts
	pnpm test

migrate:         ## apply DB migrations
	pnpm db:migrate

seed:            ## seed 2 demo clients (keys -> data/seed-clients.json)
	pnpm db:seed

db-create:       ## create local databases (native Postgres)
	psql -h localhost -U postgres -tc "select 1 from pg_database where datname='mopay'" | grep -q 1 || psql -h localhost -U postgres -c 'create database mopay'
	psql -h localhost -U postgres -tc "select 1 from pg_database where datname='mopay_test'" | grep -q 1 || psql -h localhost -U postgres -c 'create database mopay_test'

mobee:           ## run mobee-mock (port 4100)
	pnpm --filter @mopay/mobee-mock start

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
