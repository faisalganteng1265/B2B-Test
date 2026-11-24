SHELL := /bin/bash
.PHONY: deps up down reset deploy seed migrate db-create test test-contracts

deps:            ## install JS deps + foundry libs
	pnpm install
	cd contracts && [ -d lib/forge-std ] || forge install foundry-rs/forge-std --no-git
	cd contracts && [ -d lib/openzeppelin-contracts ] || forge install OpenZeppelin/openzeppelin-contracts@v5.4.0 --no-git

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
